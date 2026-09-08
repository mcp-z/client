/**
 * Hardened fetch for OAuth discovery URLs, which the remote MCP server
 * controls (SSRF mitigation). See ARCHITECTURE.md's "SSRF mitigation" section for the threat model.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';

export class DiscoveryFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryFetchError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1_000_000; // 1 MB - discovery documents are small JSON

type LookupRecord = { address: string; family: number };
/** DNS implementation, injectable for deterministic tests. Same contract as `dns.lookup` with `{ all: true, verbatim: true }`. */
type Lookup = (hostname: string, options: { all: true; verbatim: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupRecord[]) => void) => void;

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** True for the literal hostname `localhost` or an IP literal in the loopback range. */
function isLoopbackHost(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase();
  if (host === 'localhost') return true;
  if (isIP(host)) {
    try {
      return ipaddr.process(host).range() === 'loopback';
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * True if `rawUrl`'s host is loopback, used to decide `allowLoopback` grants
 * from the URL the caller configured, not remote-supplied data. Fails closed on an unparseable URL.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** True when the address is anything other than ordinary public unicast space. */
function isBlockedAddress(address: string): boolean {
  try {
    // ipaddr.process() normalizes IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4 first.
    return ipaddr.process(address).range() !== 'unicast';
  } catch {
    return true; // unparseable - fail closed
  }
}

function isLoopbackAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'loopback';
  } catch {
    return false;
  }
}

/**
 * Validates scheme and, for literal-IP hosts, address range. `allowLoopback`
 * reflects trust in the calling server, never in `rawUrl` itself.
 */
function assertSafeUrl(rawUrl: string, context: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: invalid URL`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: unsupported scheme`);
  }

  const host = stripBrackets(url.hostname);
  const trustedLoopback = allowLoopback && isLoopbackHost(host);
  if (trustedLoopback) return url; // this call's own grant covers it, regardless of scheme

  if (url.protocol === 'http:') {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: http:// is only allowed for a trusted loopback origin`);
  }

  if (isIP(host) && isBlockedAddress(host)) {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: address is not publicly routable`);
  }

  return url;
}

function lookupAll(hostname: string, lookup: Lookup, timeoutMs: number): Promise<LookupRecord[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('DNS resolution timed out'));
      }
    }, timeoutMs);
    try {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error || addresses.length === 0) reject(new Error('DNS resolution failed'));
        else resolve(addresses);
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error('DNS resolution failed'));
      }
    }
  });
}

/**
 * Resolves the hostname once, rejects it unless every returned address is
 * acceptable, and returns the validated set. The set is pinned into the
 * request itself (see `requestOnce`), which is what closes the DNS-rebinding
 * TOCTOU: the transport can only dial addresses that were already validated,
 * and it never resolves the hostname a second time.
 */
async function resolveSafeAddresses(url: URL, context: string, allowLoopback: boolean, lookup: Lookup, timeoutMs: number): Promise<LookupRecord[]> {
  const host = stripBrackets(url.hostname);
  if (isIP(host)) return [{ address: host, family: host.includes(':') ? 6 : 4 }]; // literal IP already fully checked in assertSafeUrl

  // Literal `localhost` under a trusted-loopback grant: still resolved, and the
  // answers must be loopback - the grant covers loopback, not "wherever
  // localhost happens to point".
  const loopbackGrant = allowLoopback && isLoopbackHost(host);

  let addresses: LookupRecord[];
  try {
    addresses = await lookupAll(host, lookup, timeoutMs);
  } catch {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: host could not be resolved`);
  }

  if (loopbackGrant) {
    if (!addresses.every((record) => isLoopbackAddress(record.address))) {
      throw new DiscoveryFetchError(`Refusing to fetch ${context}: host does not resolve to a loopback address`);
    }
  } else if (addresses.some((record) => isBlockedAddress(record.address))) {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: host resolves to an address that is not publicly routable`);
  }

  return addresses;
}

/**
 * A `net` lookup that can only ever answer with `addresses` - the set already
 * validated for this URL. The request is built against the original URL (so
 * SNI and certificate verification still see the hostname), but the
 * connection can only land on a validated address.
 */
function pinnedLookup(addresses: LookupRecord[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all === true) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(Object.assign(new Error('no validated address'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, '', 0);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function toRequestHeaders(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  const out: Record<string, string> = {};
  for (const [name, value] of headers) out[name] = value;
  return out;
}

async function toRequestBody(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  throw new Error('unsupported request body');
}

function toResponse(status: number, statusText: string, headers: http.IncomingHttpHeaders, body: Buffer): Response {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(name, entry);
    } else {
      responseHeaders.append(name, value);
    }
  }
  // The fetch spec gives these statuses a null body, and the Response
  // constructor rejects a body for them.
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, { status, statusText, headers: responseHeaders });
}

async function requestOnce(url: URL, init: RequestInit, context: string, addresses: LookupRecord[], timeoutMs: number): Promise<Response> {
  let body: Buffer | undefined;
  try {
    body = await toRequestBody(init.body);
  } catch {
    throw new DiscoveryFetchError(`Failed to fetch ${context}`);
  }

  const transport = url.protocol === 'https:' ? https : http;
  const options: http.RequestOptions = { method: (init.method ?? 'GET').toUpperCase(), headers: toRequestHeaders(init), agent: false, lookup: pinnedLookup(addresses) };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    const fail = (message: string): void => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new DiscoveryFetchError(message));
      }
    };
    const deadline = setTimeout(() => {
      res?.destroy();
      req?.destroy();
      fail(`Failed to fetch ${context}`);
    }, timeoutMs);

    try {
      req = transport.request(url, options, (response) => {
        res = response;
        const status = response.statusCode;
        const statusText = response.statusMessage ?? '';
        if (status === undefined || status < 200 || status > 599) {
          response.destroy();
          fail(`Failed to fetch ${context}`);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            response.destroy();
            fail(`Refusing to read ${context}: response too large`);
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => fail(`Failed to fetch ${context}`));
        response.once('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(toResponse(status, statusText, response.headers, Buffer.concat(chunks)));
        });
      });
    } catch {
      fail(`Failed to fetch ${context}`);
      return;
    }

    req.once('error', () => fail(`Failed to fetch ${context}`));
    req.end(body);
  });
}

async function fetchOnce(url: URL, init: RequestInit, context: string, allowLoopback: boolean, timeoutMs: number, lookup: Lookup): Promise<Response> {
  const addresses = await resolveSafeAddresses(url, context, allowLoopback, lookup, timeoutMs);
  return requestOnce(url, init, context, addresses, timeoutMs);
}

export interface DiscoveryFetchOptions {
  /**
   * Loopback trust grant for this fetch, computed from the server the caller
   * is actually talking to - never from the URL being fetched. Defaults to `false`.
   */
  allowLoopback?: boolean;
  /**
   * Per-hop timeout in ms, applied to both the DNS resolution and the request.
   * Defaults to `DEFAULT_TIMEOUT_MS`; overridable so tests can bound slow-failure cases.
   */
  timeoutMs?: number;
  /**
   * DNS implementation used for the pre-request resolution, injectable for
   * deterministic tests. Defaults to `dns.lookup`.
   */
  lookup?: Lookup;
}

/**
 * Fetches an OAuth-discovery URL with SSRF mitigations applied to the
 * initial URL and every redirect hop; redirects are validated, not auto-followed.
 *
 * The hostname is resolved once, every returned address is validated, and the
 * validated set is pinned into the request through a custom `lookup`, so the
 * request cannot resolve the hostname a second time and cannot be steered to
 * a different address by a DNS-rebinding answer.
 *
 * @param rawUrl - URL to fetch; may be remote-server-supplied (the threat this guards against).
 * @param init - Standard fetch options; `redirect` is always forced to `'manual'`.
 * @param context - Short label used only in error messages, never echoing the URL.
 * @param options - See `DiscoveryFetchOptions`.
 */
export async function discoveryFetch(rawUrl: string, init: RequestInit = {}, context = 'discovery URL', options: DiscoveryFetchOptions = {}): Promise<Response> {
  const { allowLoopback = false, timeoutMs = DEFAULT_TIMEOUT_MS, lookup = dns.lookup as unknown as Lookup } = options;

  let url = assertSafeUrl(rawUrl, context, allowLoopback);
  let response = await fetchOnce(url, init, context, allowLoopback, timeoutMs, lookup);

  let redirectsLeft = MAX_REDIRECTS;
  while (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) break;
    if (redirectsLeft <= 0) {
      throw new DiscoveryFetchError(`Refusing to fetch ${context}: too many redirects`);
    }
    redirectsLeft -= 1;

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, url);
    } catch {
      throw new DiscoveryFetchError(`Refusing to fetch ${context}: invalid redirect target`);
    }
    url = assertSafeUrl(nextUrl.toString(), context, allowLoopback);
    response = await fetchOnce(url, init, context, allowLoopback, timeoutMs, lookup);
  }

  return response;
}

/**
 * Parse a `discoveryFetch` response body as JSON, enforcing `MAX_BODY_BYTES`
 * while reading (not after buffering the whole thing).
 */
export async function readDiscoveryJson<T>(response: Response, context: string): Promise<T> {
  const text = await readLimited(response, context, MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DiscoveryFetchError(`Refusing to parse ${context}: invalid JSON`);
  }
}

async function readLimited(response: Response, context: string, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new DiscoveryFetchError(`Refusing to read ${context}: response too large`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new DiscoveryFetchError(`Refusing to read ${context}: response too large`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new DiscoveryFetchError(`Refusing to read ${context}: response too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
