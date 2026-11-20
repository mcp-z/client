/**
 * OAuth Server Capability Discovery
 * Probes RFC 9728 (Protected Resource) and RFC 8414 (Authorization Server) metadata
 */

import { normalizeUrl } from '../lib/url-utils.ts';
import { isLoopbackUrl, speculativeProbe, throwIfAborted } from './discovery-fetch.ts';
import { discoverAuthorizationServerIssuer, discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata } from './rfc9728-discovery.ts';
import type { AuthCapabilities, AuthorizationServerMetadata } from './types.ts';

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
 * Probe OAuth server capabilities using RFC 9728 → RFC 8414 discovery chain
 * Returns capabilities including DCR support detection
 *
 * Discovery Strategy:
 * 1. Try RFC 9728 Protected Resource Metadata (supports cross-domain OAuth)
 * 2. If found, use first authorization_server to discover RFC 8414 Authorization Server Metadata
 * 3. Fall back to direct RFC 8414 discovery at resource origin
 *
 * @param baseUrl - Base URL of the protected resource (e.g., https://ai.todoist.net/mcp)
 * @returns AuthCapabilities object with discovered endpoints and features
 *
 * @example
 * // Todoist case: MCP at ai.todoist.net/mcp, OAuth at todoist.com
 * const caps = await probeAuthCapabilities('https://ai.todoist.net/mcp');
 * if (caps.supportsDcr) {
 *   console.log('Registration endpoint:', caps.registrationEndpoint);
 * }
 */
function buildCapabilities(metadata: AuthorizationServerMetadata, scopes?: string[], resource?: string): AuthCapabilities {
  const supportsDcr = !!metadata.registration_endpoint;
  const capabilities: AuthCapabilities = { supportsDcr, authorizationResponseIssSupported: metadata.authorization_response_iss_parameter_supported === true, authorizationServerMetadata: metadata };

  if (metadata.client_id_metadata_document_supported === true) {
    capabilities.supportsCimd = true;
  }

  if (metadata.issuer) {
    capabilities.issuer = metadata.issuer;
  }

  // Carried from the RFC 9728 document, not from the URL we were given: the
  // resource server names itself, and that name is what RFC 8707 audience-binds
  // a token to.
  if (resource) {
    capabilities.resource = resource;
  }

  if (metadata.registration_endpoint) {
    capabilities.registrationEndpoint = metadata.registration_endpoint;
  }
  if (metadata.authorization_endpoint) {
    capabilities.authorizationEndpoint = metadata.authorization_endpoint;
  }
  if (metadata.token_endpoint) capabilities.tokenEndpoint = metadata.token_endpoint;
  if (metadata.introspection_endpoint) {
    capabilities.introspectionEndpoint = metadata.introspection_endpoint;
  }

  if (scopes && scopes.length > 0) {
    capabilities.scopes = scopes;
  } else if (metadata.scopes_supported) {
    capabilities.scopes = metadata.scopes_supported;
  }

  return capabilities;
}

/**
 * The issuer in the metadata must be the authorization server the metadata was fetched for (RFC 8414 section 3.3).
 * Otherwise a server could name another issuer, whose credentials the client holds, and point the token endpoint at itself.
 */
function assertIssuerMatches(metadata: AuthorizationServerMetadata, authServerUrl: string): void {
  if (metadata.issuer !== undefined && normalizeUrl(metadata.issuer) !== normalizeUrl(authServerUrl)) {
    throw new Error('Authorization server metadata names a different issuer than the authorization server it was fetched for (RFC 8414 section 3.3) - refusing to use it');
  }
}

async function resolveCapabilitiesFromAuthorizationServer(authServerUrl: string, scopes: string[] | undefined, allowLoopback: boolean, resource?: string, signal?: AbortSignal): Promise<AuthCapabilities | null> {
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { allowLoopback, signal });
  if (!metadata) return null;
  assertIssuerMatches(metadata, authServerUrl);
  return buildCapabilities(metadata, scopes, resource);
}

export async function probeAuthCapabilities(baseUrl: string, options: { signal?: AbortSignal } = {}): Promise<AuthCapabilities> {
  const { signal } = options;
  throwIfAborted(signal);
  const normalizedBaseUrl = normalizeUrl(baseUrl);
  // Trust signal for every authorization-server fetch below: whether the
  // configured MCP server is itself loopback, never a remote-supplied URL.
  const allowLoopback = isLoopbackUrl(normalizedBaseUrl);
  // Strategy 1: Try RFC 9728 Protected Resource Metadata discovery
  // This handles cross-domain OAuth (e.g., Todoist: ai.todoist.net/mcp → todoist.com)
  const resourceMetadata = await discoverProtectedResourceMetadata(normalizedBaseUrl, { signal });

  if (resourceMetadata && resourceMetadata.authorization_servers.length > 0) {
    // Found protected resource metadata with authorization servers
    // Discover the authorization server's metadata (RFC 8414)
    const authServerUrl = resourceMetadata.authorization_servers[0];
    if (!authServerUrl) {
      // Array has length > 0 but first element is undefined/null - skip this path
      return { supportsDcr: false };
    }
    const capabilities = await resolveCapabilitiesFromAuthorizationServer(authServerUrl, resourceMetadata.scopes_supported, allowLoopback, resourceMetadata.resource, signal);
    if (capabilities) {
      return capabilities;
    }

    const issuer = await discoverAuthorizationServerIssuer(baseUrl, { signal });
    if (issuer) {
      const issuerCapabilities = await resolveCapabilitiesFromAuthorizationServer(issuer, resourceMetadata.scopes_supported, allowLoopback, resourceMetadata.resource, signal);
      if (issuerCapabilities) return issuerCapabilities;
    }
  }

  const issuer = await discoverAuthorizationServerIssuer(normalizedBaseUrl, { signal });
  if (issuer) {
    const issuerCapabilities = await resolveCapabilitiesFromAuthorizationServer(issuer, undefined, allowLoopback, undefined, signal);
    if (issuerCapabilities) return issuerCapabilities;
  }

  // Strategy 2 (speculative: the origin was not advertised): fall back to direct RFC 8414 discovery at resource origin
  // This handles same-domain OAuth (traditional setup)
  const origin = getOrigin(normalizedBaseUrl);
  const originMetadata = await speculativeProbe(signal, () => discoverAuthorizationServerMetadata(origin, { allowLoopback, signal }));
  if (originMetadata) {
    assertIssuerMatches(originMetadata, origin);
    return buildCapabilities(originMetadata);
  }

  // No OAuth metadata found
  return { supportsDcr: false };
}
