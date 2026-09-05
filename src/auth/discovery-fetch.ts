/**
 * Hardened fetch for OAuth discovery URLs, which the remote MCP server
 * controls (SSRF mitigation). See ARCHITECTURE.md's "SSRF mitigation" section for the threat model.
 */
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
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

/**
 * Resolves the hostname and rejects it if any address is private/reserved.
 * Does not close the DNS-rebinding TOCTOU race against `fetch`'s own resolution a moment later.
 */
async function assertResolvesToSafeAddress(url: URL, context: string, allowLoopback: boolean): Promise<void> {
  const host = stripBrackets(url.hostname);
  if (isIP(host)) return; // literal IP already fully checked in assertSafeUrl
  if (allowLoopback && isLoopbackHost(host)) return; // literal "localhost" under a trusted-loopback grant

  let addresses: string[];
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: host could not be resolved`);
  }

  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new DiscoveryFetchError(`Refusing to fetch ${context}: host resolves to an address that is not publicly routable`);
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

async function fetchOnce(url: URL, init: RequestInit, context: string, allowLoopback: boolean, timeoutMs: number): Promise<Response> {
  await assertResolvesToSafeAddress(url, context, allowLoopback);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch {
    // Never surface the underlying error (ECONNREFUSED host/port, DNS detail, etc.)
    throw new DiscoveryFetchError(`Failed to fetch ${context}`);
  } finally {
    clearTimeout(timeout);
  }
}

export interface DiscoveryFetchOptions {
  /**
   * Loopback trust grant for this fetch, computed from the server the caller
   * is actually talking to - never from the URL being fetched. Defaults to `false`.
   */
  allowLoopback?: boolean;
  /**
   * Per-request connect/read timeout in ms. Defaults to `DEFAULT_TIMEOUT_MS`;
   * overridable so tests can bound slow-failure cases.
   */
  timeoutMs?: number;
}

/**
 * Fetches an OAuth-discovery URL with SSRF mitigations applied to the
 * initial URL and every redirect hop; redirects are validated, not auto-followed.
 *
 * @param rawUrl - URL to fetch; may be remote-server-supplied (the threat this guards against).
 * @param init - Standard fetch options; `redirect` is always forced to `'manual'`.
 * @param context - Short label used only in error messages, never echoing the URL.
 * @param options - See `DiscoveryFetchOptions`.
 */
export async function discoveryFetch(rawUrl: string, init: RequestInit = {}, context = 'discovery URL', options: DiscoveryFetchOptions = {}): Promise<Response> {
  const { allowLoopback = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  let url = assertSafeUrl(rawUrl, context, allowLoopback);
  let response = await fetchOnce(url, init, context, allowLoopback, timeoutMs);

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
    response = await fetchOnce(url, init, context, allowLoopback, timeoutMs);
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
