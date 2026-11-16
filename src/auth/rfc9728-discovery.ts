/**
 * RFC 9728 Protected Resource Metadata Discovery
 * Probes .well-known/oauth-protected-resource endpoint
 */

import { joinWellKnown, normalizeUrl } from '../lib/url-utils.ts';
import { DiscoveryFetchError, discoveryFetch, isLoopbackUrl, readDiscoveryJson, speculativeProbe, throwIfAborted } from './discovery-fetch.ts';
import type { AuthorizationServerMetadata, ProtectedResourceMetadata } from './types.ts';

/** Returns `url`'s origin (protocol + host), or the original string if it doesn't parse. */
function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Returns `url`'s pathname, or `''` for the root path or an unparseable URL. */
function getPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? '' : parsed.pathname;
  } catch {
    return '';
  }
}

/**
 * Discovers RFC 9728 Protected Resource Metadata: the `WWW-Authenticate`
 * header first, then `.well-known/oauth-protected-resource` at the origin root and, for a path-prefixed resource, its sub-path variant.
 *
 * @param resourceUrl - URL of the protected resource (e.g. `https://ai.todoist.net/mcp`).
 * @returns Discovered metadata, or `null` if none is found.
 */
export async function discoverProtectedResourceMetadata(resourceUrl: string, options: { signal?: AbortSignal } = {}): Promise<ProtectedResourceMetadata | null> {
  const { signal } = options;
  throwIfAborted(signal);
  const normalizedResourceUrl = normalizeUrl(resourceUrl);
  // resourceUrl is the server the caller configured (never remote-supplied);
  // its loopback-ness is the trust signal every fetch below relies on.
  const allowLoopback = isLoopbackUrl(normalizedResourceUrl);
  const headerMetadata = await discoverProtectedResourceMetadataFromHeader(normalizedResourceUrl, allowLoopback, signal);
  if (headerMetadata) return headerMetadata;

  // These well-known locations are guesses, not something the server advertised:
  // a failure or a non-2xx answer means "not offered", so try the next one.
  const fetchMetadata = (url: string, context: string): Promise<ProtectedResourceMetadata | null> =>
    speculativeProbe(signal, async () => {
      const response = await discoveryFetch(url, { method: 'GET', headers: { Accept: 'application/json', Connection: 'close' }, signal }, context, { allowLoopback });
      if (!response.ok) return null;
      return readDiscoveryJson<ProtectedResourceMetadata>(response, context);
    });

  // Strategy 0: Try path-local well-known (supports path-prefixed deployments like /outlook)
  const localMetadata = await fetchMetadata(joinWellKnown(normalizedResourceUrl, '/.well-known/oauth-protected-resource'), 'protected resource metadata (path-local)');
  if (localMetadata) return localMetadata;

  const origin = getOrigin(normalizedResourceUrl);
  const path = getPath(normalizedResourceUrl);
  const subPathUrl = `${origin}/.well-known/oauth-protected-resource${path}`;

  // Strategy 1: Try root location (REQUIRED by RFC 9728)
  const rootMetadata = await fetchMetadata(`${origin}/.well-known/oauth-protected-resource`, 'protected resource metadata (root)');
  if (rootMetadata) {
    // Check if the discovered resource matches what we're looking for
    if (rootMetadata.resource === normalizedResourceUrl) return rootMetadata;
    // If there's no path component, return root metadata
    if (!path) return rootMetadata;
    // Root metadata applies to sub-paths; prefer more specific sub-path metadata when it exists
    if (normalizedResourceUrl.startsWith(rootMetadata.resource)) {
      const specific = await fetchMetadata(subPathUrl, 'protected resource metadata (sub-path)');
      return specific ?? rootMetadata;
    }
    // Otherwise, try sub-path location before giving up
  }

  // Strategy 2: Try sub-path location (MCP spec extension), only with a path component
  if (path) {
    const subPathMetadata = await fetchMetadata(subPathUrl, 'protected resource metadata (sub-path)');
    if (subPathMetadata) return subPathMetadata;
  }

  // Neither location found or resource didn't match
  return null;
}

async function discoverProtectedResourceMetadataFromHeader(resourceUrl: string, allowLoopback: boolean, signal?: AbortSignal): Promise<ProtectedResourceMetadata | null> {
  throwIfAborted(signal);
  // The unprompted fetch of the resource URL is speculative: nothing has been advertised yet.
  const header = await speculativeProbe(signal, async () => {
    const response = await fetch(resourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
      signal,
    });

    const first = response.headers.get('www-authenticate');
    if (first) return first;
    const postResponse = await fetch(resourceUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', Connection: 'close', 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
    return postResponse.headers.get('www-authenticate');
  });

  if (!header) return null;

  const match = header.match(/resource_metadata="([^"]+)"/i);
  if (!match || !match[1]) return null;

  // From here the location was advertised by the server, so failures reject.
  // metadataUrl is remote-server-chosen (the primary SSRF vector here);
  // allowLoopback reflects trust in resourceUrl, not in metadataUrl.
  const metadataUrl = match[1];
  const metadataResponse = await discoveryFetch(
    metadataUrl,
    {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
      signal,
    },
    'resource_metadata URL',
    { allowLoopback }
  );

  if (!metadataResponse.ok) {
    throw new DiscoveryFetchError(`resource_metadata URL returned HTTP ${metadataResponse.status}`);
  }

  return await readDiscoveryJson<ProtectedResourceMetadata>(metadataResponse, 'resource_metadata URL');
}

/**
 * Discovers RFC 8414 Authorization Server Metadata at
 * `.well-known/oauth-authorization-server`, path-local variant first.
 *
 * @param authServerUrl - URL of the authorization server (typically from RFC 9728 discovery).
 * @param options.allowLoopback - Loopback trust grant computed from the server the caller is actually talking to, never from `authServerUrl` itself. Defaults to `false`.
 * @returns Discovered metadata, or `null` if none is found.
 */
export async function discoverAuthorizationServerMetadata(authServerUrl: string, options: { allowLoopback?: boolean; signal?: AbortSignal } = {}): Promise<AuthorizationServerMetadata | null> {
  const { allowLoopback = false, signal } = options;
  throwIfAborted(signal);
  const normalizedAuthServerUrl = normalizeUrl(authServerUrl);
  const localWellKnownUrl = joinWellKnown(normalizedAuthServerUrl, '/.well-known/oauth-authorization-server');
  const localResponse = await discoveryFetch(
    localWellKnownUrl,
    {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
      signal,
    },
    'authorization server metadata (path-local)',
    { allowLoopback }
  );

  if (localResponse.ok) {
    return await readDiscoveryJson<AuthorizationServerMetadata>(localResponse, 'authorization server metadata (path-local)');
  }

  const origin = getOrigin(normalizedAuthServerUrl);
  const wellKnownUrl = `${origin}/.well-known/oauth-authorization-server`;

  const response = await discoveryFetch(
    wellKnownUrl,
    {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
      signal,
    },
    'authorization server metadata',
    { allowLoopback }
  );

  if (!response.ok) {
    return null;
  }

  return await readDiscoveryJson<AuthorizationServerMetadata>(response, 'authorization server metadata');
}

/**
 * Discover OAuth Authorization Server Issuer from resource response (RFC 9207)
 *
 * @param resourceUrl - URL of the protected resource
 * @returns Issuer URL if present in WWW-Authenticate header, null otherwise
 */
export async function discoverAuthorizationServerIssuer(resourceUrl: string, options: { signal?: AbortSignal } = {}): Promise<string | null> {
  const { signal } = options;
  throwIfAborted(signal);
  // Fetching the resource URL unprompted is speculative; only a header it returns is advertised.
  const header = await speculativeProbe(signal, async () => {
    const response = await fetch(resourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
      signal,
    });
    return response.headers.get('www-authenticate');
  });
  if (!header) return null;

  const match = header.match(/(?:authorization_server|issuer)="([^"]+)"/i);
  if (!match) return null;

  return match[1] ?? null;
}
