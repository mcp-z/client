/**
 * RFC 9728 Protected Resource Metadata Discovery
 * Probes .well-known/oauth-protected-resource endpoint
 */

import type { AuthorizationServerMetadata, ProtectedResourceMetadata } from './types.ts';

/**
 * Extract origin (protocol + host) from a URL
 * @param url - Full URL that may include a path
 * @returns Origin (e.g., "https://example.com") or original string if invalid URL
 *
 * @example
 * getOrigin('https://example.com/mcp') // → 'https://example.com'
 * getOrigin('http://localhost:9999/api/v1/mcp') // → 'http://localhost:9999'
 */
function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // Invalid URL - return as-is for graceful degradation
    return url;
  }
}

/**
 * Extract path from a URL (without origin)
 * @param url - Full URL
 * @returns Path component (e.g., "/mcp", "/api/v1/mcp") or empty string if no path
 */
function getPath(url: string): string {
  try {
    const parsed = new URL(url);
    // pathname includes leading slash, e.g., "/mcp"
    return parsed.pathname === '/' ? '' : parsed.pathname;
  } catch {
    return '';
  }
}

/**
 * Discover OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Probes .well-known/oauth-protected-resource endpoint
 *
 * Discovery Strategy:
 * 1. Try origin root: {origin}/.well-known/oauth-protected-resource
 * 2. If 404, try sub-path: {origin}/.well-known/oauth-protected-resource{path}
 *
 * @param resourceUrl - URL of the protected resource (e.g., https://ai.todoist.net/mcp)
 * @returns ProtectedResourceMetadata if discovered, null otherwise
 *
 * @example
 * // Todoist case: MCP at ai.todoist.net/mcp, OAuth at todoist.com
 * const metadata = await discoverProtectedResourceMetadata('https://ai.todoist.net/mcp');
 * // Returns: { resource: "https://ai.todoist.net/mcp", authorization_servers: ["https://todoist.com"] }
 */
export async function discoverProtectedResourceMetadata(resourceUrl: string): Promise<ProtectedResourceMetadata | null> {
  try {
    const headerMetadata = await discoverProtectedResourceMetadataFromHeader(resourceUrl);
    if (headerMetadata) return headerMetadata;

    const origin = getOrigin(resourceUrl);
    const path = getPath(resourceUrl);

    // Strategy 1: Try root location (REQUIRED by RFC 9728)
    const rootUrl = `${origin}/.well-known/oauth-protected-resource`;

    try {
      const response = await fetch(rootUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' },
      });

      if (response.ok) {
        const metadata = (await response.json()) as ProtectedResourceMetadata;
        // Check if the discovered resource matches what we're looking for
        if (metadata.resource === resourceUrl) {
          return metadata;
        }
        // If there's no path component, return root metadata
        // (e.g., looking for http://example.com and found it)
        if (!path) {
          return metadata;
        }
        // If requested URL starts with metadata.resource, the root metadata applies to sub-paths
        // (e.g., looking for http://example.com/api/v1/mcp, found http://example.com)
        if (resourceUrl.startsWith(metadata.resource)) {
          // Still try sub-path location to see if there's more specific metadata
          // But save root metadata as fallback
          const rootMetadata = metadata;

          // Try sub-path location for more specific metadata
          const subPathUrl = `${origin}/.well-known/oauth-protected-resource${path}`;
          try {
            const subPathResponse = await fetch(subPathUrl, {
              method: 'GET',
              headers: { Accept: 'application/json', Connection: 'close' },
            });
            if (subPathResponse.ok) {
              return (await subPathResponse.json()) as ProtectedResourceMetadata;
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
        const response = await fetch(subPathUrl, {
          method: 'GET',
          headers: { Accept: 'application/json', Connection: 'close' },
        });

        if (response.ok) {
          return (await response.json()) as ProtectedResourceMetadata;
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

async function discoverProtectedResourceMetadataFromHeader(resourceUrl: string): Promise<ProtectedResourceMetadata | null> {
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

    const metadataUrl = match[1];
    const metadataResponse = await fetch(metadataUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
    });

    if (!metadataResponse.ok) {
      return null;
    }

    return (await metadataResponse.json()) as ProtectedResourceMetadata;
  } catch (_error) {
    return null;
  }
}

/**
 * Discover OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * Probes .well-known/oauth-authorization-server endpoint
 *
 * @param authServerUrl - URL of the authorization server (typically from RFC 9728 discovery)
 * @returns AuthorizationServerMetadata if discovered, null otherwise
 *
 * @example
 * const metadata = await discoverAuthorizationServerMetadata('https://todoist.com');
 * // Returns: { issuer: "https://todoist.com", authorization_endpoint: "...", ... }
 */
export async function discoverAuthorizationServerMetadata(authServerUrl: string): Promise<AuthorizationServerMetadata | null> {
  try {
    const origin = getOrigin(authServerUrl);
    const wellKnownUrl = `${origin}/.well-known/oauth-authorization-server`;

    const response = await fetch(wellKnownUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Connection: 'close' },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as AuthorizationServerMetadata;
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
