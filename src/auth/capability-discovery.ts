/**
 * OAuth Server Capability Discovery
 * Probes RFC 9728 (Protected Resource) and RFC 8414 (Authorization Server) metadata
 */

import { normalizeUrl } from '../lib/url-utils.ts';
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
function buildCapabilities(metadata: AuthorizationServerMetadata, scopes?: string[]): AuthCapabilities {
  const supportsDcr = !!metadata.registration_endpoint;
  const capabilities: AuthCapabilities = { supportsDcr };

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

async function resolveCapabilitiesFromAuthorizationServer(authServerUrl: string, scopes?: string[]): Promise<AuthCapabilities | null> {
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl);
  if (!metadata) return null;
  return buildCapabilities(metadata, scopes);
}

export async function probeAuthCapabilities(baseUrl: string): Promise<AuthCapabilities> {
  try {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    // Strategy 1: Try RFC 9728 Protected Resource Metadata discovery
    // This handles cross-domain OAuth (e.g., Todoist: ai.todoist.net/mcp → todoist.com)
    const resourceMetadata = await discoverProtectedResourceMetadata(normalizedBaseUrl);

    if (resourceMetadata && resourceMetadata.authorization_servers.length > 0) {
      // Found protected resource metadata with authorization servers
      // Discover the authorization server's metadata (RFC 8414)
      const authServerUrl = resourceMetadata.authorization_servers[0];
      if (!authServerUrl) {
        // Array has length > 0 but first element is undefined/null - skip this path
        return { supportsDcr: false };
      }
      const capabilities = await resolveCapabilitiesFromAuthorizationServer(authServerUrl, resourceMetadata.scopes_supported);
      if (capabilities) {
        return capabilities;
      }

      const issuer = await discoverAuthorizationServerIssuer(baseUrl);
      if (issuer) {
        const issuerCapabilities = await resolveCapabilitiesFromAuthorizationServer(issuer, resourceMetadata.scopes_supported);
        if (issuerCapabilities) return issuerCapabilities;
      }
    }

    const issuer = await discoverAuthorizationServerIssuer(normalizedBaseUrl);
    if (issuer) {
      const issuerCapabilities = await resolveCapabilitiesFromAuthorizationServer(issuer);
      if (issuerCapabilities) return issuerCapabilities;
    }

    // Strategy 2: Fall back to direct RFC 8414 discovery at resource origin
    // This handles same-domain OAuth (traditional setup)
    const origin = getOrigin(normalizedBaseUrl);
    const originCapabilities = await resolveCapabilitiesFromAuthorizationServer(origin);
    if (originCapabilities) return originCapabilities;

    // No OAuth metadata found
    return { supportsDcr: false };
  } catch (_error) {
    // Network error, invalid JSON, or other fetch failure
    // Gracefully degrade - assume no DCR support
    return { supportsDcr: false };
  }
}
