/**
 * RFC 9728 Protected Resource Metadata Discovery
 * Probes .well-known/oauth-protected-resource endpoint
 */

import { joinWellKnown, normalizeUrl } from '../lib/url-utils.ts';
import { discoveryFetch, isLoopbackUrl, readDiscoveryJson } from './discovery-fetch.ts';
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
export async function discoverProtectedResourceMetadata(resourceUrl: string): Promise<ProtectedResourceMetadata | null> {
  try {
    const normalizedResourceUrl = normalizeUrl(resourceUrl);
    // resourceUrl is the server the caller configured (never remote-supplied);
    // its loopback-ness is the trust signal every fetch below relies on.
    const allowLoopback = isLoopbackUrl(normalizedResourceUrl);
    const headerMetadata = await discoverProtectedResourceMetadataFromHeader(normalizedResourceUrl, allowLoopback);
    if (headerMetadata) return headerMetadata;

    // Strategy 0: Try path-local well-known (supports path-prefixed deployments like /outlook)
    const localWellKnownUrl = joinWellKnown(normalizedResourceUrl, '/.well-known/oauth-protected-resource');
    try {
      const response = await discoveryFetch(
        localWellKnownUrl,
        {
          method: 'GET',
          headers: { Accept: 'application/json', Connection: 'close' },
        },
        'protected resource metadata (path-local)',
        { allowLoopback }
      );
      if (response.ok) {
        return await readDiscoveryJson<ProtectedResourceMetadata>(response, 'protected resource metadata (path-local)');
      }
    } catch {
      // Continue to origin-based discovery
    }

    const origin = getOrigin(normalizedResourceUrl);
    const path = getPath(normalizedResourceUrl);

    // Strategy 1: Try root location (REQUIRED by RFC 9728)
    const rootUrl = `${origin}/.well-known/oauth-protected-resource`;

    try {
      const response = await discoveryFetch(
        rootUrl,
        {
          method: 'GET',
          headers: { Accept: 'application/json', Connection: 'close' },
        },
        'protected resource metadata (root)',
        { allowLoopback }
      );

      if (response.ok) {
        const metadata = await readDiscoveryJson<ProtectedResourceMetadata>(response, 'protected resource metadata (root)');
        // Check if the discovered resource matches what we're looking for
        if (metadata.resource === normalizedResourceUrl) {
          return metadata;
        }
        // If there's no path component, return root metadata
        // (e.g., looking for http://example.com and found it)
        if (!path) {
          return metadata;
        }
        // If requested URL starts with metadata.resource, the root metadata applies to sub-paths
        // (e.g., looking for http://example.com/api/v1/mcp, found http://example.com)
        if (normalizedResourceUrl.startsWith(metadata.resource)) {
          // Still try sub-path location to see if there's more specific metadata
          // But save root metadata as fallback
          const rootMetadata = metadata;

          // Try sub-path location for more specific metadata
          const subPathUrl = `${origin}/.well-known/oauth-protected-resource${path}`;
          try {
            const subPathResponse = await discoveryFetch(
              subPathUrl,
              {
                method: 'GET',
                headers: { Accept: 'application/json', Connection: 'close' },
              },
              'protected resource metadata (sub-path)',
              { allowLoopback }
            );
            if (subPathResponse.ok) {
              return await readDiscoveryJson<ProtectedResourceMetadata>(subPathResponse, 'protected resource metadata (sub-path)');
            }
          } catch {
            // Sub-path failed, use root metadata
          }

          // Return root metadata as it applies to this resource
          return rootMetadata;
        }
        // Otherwise, try sub-path location before giving up
      }
    } catch {
      // Continue to sub-path location
    }

    // Strategy 2: Try sub-path location (MCP spec extension)
    // Only try if there's a path component
    if (path) {
      const subPathUrl = `${origin}/.well-known/oauth-protected-resource${path}`;

      try {
        const response = await discoveryFetch(
          subPathUrl,
          {
            method: 'GET',
            headers: { Accept: 'application/json', Connection: 'close' },
          },
          'protected resource metadata (sub-path)',
          { allowLoopback }
        );

        if (response.ok) {
          return await readDiscoveryJson<ProtectedResourceMetadata>(response, 'protected resource metadata (sub-path)');
        }
      } catch {
        // Fall through to return null
      }
    }

    // Neither location found or resource didn't match
    return null;
  } catch (_error) {
    // Network error, invalid URL, or other failure
    return null;
  }
}

async function discoverProtectedResourceMetadataFromHeader(resourceUrl: string, allowLoopback: boolean): Promise<ProtectedResourceMetadata | null> {
  try {
    const response = await fetch(resourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
    });

    let header = response.headers.get('www-authenticate');
    if (!header) {
      const postResponse = await fetch(resourceUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', Connection: 'close', 'Content-Type': 'application/json' },
        body: '{}',
      });
      header = postResponse.headers.get('www-authenticate');
    }

    if (!header) return null;

    const match = header.match(/resource_metadata="([^"]+)"/i);
    if (!match || !match[1]) return null;

    // metadataUrl is remote-server-chosen (the primary SSRF vector here);
    // allowLoopback reflects trust in resourceUrl, not in metadataUrl.
    const metadataUrl = match[1];
    const metadataResponse = await discoveryFetch(
      metadataUrl,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' },
      },
      'resource_metadata URL',
      { allowLoopback }
    );

    if (!metadataResponse.ok) {
      return null;
    }

    return await readDiscoveryJson<ProtectedResourceMetadata>(metadataResponse, 'resource_metadata URL');
  } catch (_error) {
    return null;
  }
}

/**
 * Discovers RFC 8414 Authorization Server Metadata at
 * `.well-known/oauth-authorization-server`, path-local variant first.
 *
 * @param authServerUrl - URL of the authorization server (typically from RFC 9728 discovery).
 * @param options.allowLoopback - Loopback trust grant computed from the server the caller is actually talking to, never from `authServerUrl` itself. Defaults to `false`.
 * @returns Discovered metadata, or `null` if none is found.
 */
export async function discoverAuthorizationServerMetadata(authServerUrl: string, options: { allowLoopback?: boolean } = {}): Promise<AuthorizationServerMetadata | null> {
  const { allowLoopback = false } = options;
  try {
    const normalizedAuthServerUrl = normalizeUrl(authServerUrl);
    const localWellKnownUrl = joinWellKnown(normalizedAuthServerUrl, '/.well-known/oauth-authorization-server');
    const localResponse = await discoveryFetch(
      localWellKnownUrl,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' },
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
      },
      'authorization server metadata',
      { allowLoopback }
    );

    if (!response.ok) {
      return null;
    }

    return await readDiscoveryJson<AuthorizationServerMetadata>(response, 'authorization server metadata');
  } catch (_error) {
    return null;
  }
}

/**
 * Discover OAuth Authorization Server Issuer from resource response (RFC 9207)
 *
 * @param resourceUrl - URL of the protected resource
 * @returns Issuer URL if present in WWW-Authenticate header, null otherwise
 */
export async function discoverAuthorizationServerIssuer(resourceUrl: string): Promise<string | null> {
  try {
    const response = await fetch(resourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
    });

    const header = response.headers.get('www-authenticate');
    if (!header) return null;

    const match = header.match(/(?:authorization_server|issuer)="([^"]+)"/i);
    if (!match) return null;

    return match[1] ?? null;
  } catch (_error) {
    return null;
  }
}
