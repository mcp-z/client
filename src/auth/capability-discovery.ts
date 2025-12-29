/**
 * OAuth Server Capability Discovery
 * Probes RFC 9728 (Protected Resource) and RFC 8414 (Authorization Server) metadata
 */

import { discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata } from './rfc9728-discovery.ts';
import type { AuthCapabilities } from './types.ts';

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
export async function probeAuthCapabilities(baseUrl: string): Promise<AuthCapabilities> {
  try {
    // Strategy 1: Try RFC 9728 Protected Resource Metadata discovery
    // This handles cross-domain OAuth (e.g., Todoist: ai.todoist.net/mcp → todoist.com)
    const resourceMetadata = await discoverProtectedResourceMetadata(baseUrl);

    if (resourceMetadata && resourceMetadata.authorization_servers.length > 0) {
      // Found protected resource metadata with authorization servers
      // Discover the authorization server's metadata (RFC 8414)
      const authServerUrl = resourceMetadata.authorization_servers[0];
      if (!authServerUrl) {
        // Array has length > 0 but first element is undefined/null - skip this path
        return { supportsDcr: false };
      }
      const authServerMetadata = await discoverAuthorizationServerMetadata(authServerUrl);

      if (authServerMetadata) {
        // Successfully discovered full OAuth metadata via RFC 9728 → RFC 8414 chain
        const supportsDcr = !!authServerMetadata.registration_endpoint;
        const capabilities: AuthCapabilities = { supportsDcr };

        if (authServerMetadata.registration_endpoint) {
          capabilities.registrationEndpoint = authServerMetadata.registration_endpoint;
        }
        if (authServerMetadata.authorization_endpoint) {
          capabilities.authorizationEndpoint = authServerMetadata.authorization_endpoint;
        }
        if (authServerMetadata.token_endpoint) capabilities.tokenEndpoint = authServerMetadata.token_endpoint;
        if (authServerMetadata.introspection_endpoint) {
          capabilities.introspectionEndpoint = authServerMetadata.introspection_endpoint;
        }

        // Prefer resource scopes over auth server scopes
        const scopes = resourceMetadata.scopes_supported || authServerMetadata.scopes_supported;
        if (scopes) capabilities.scopes = scopes;

        return capabilities;
      }
    }

    // Strategy 2: Fall back to direct RFC 8414 discovery at resource origin
    // This handles same-domain OAuth (traditional setup)
    const origin = getOrigin(baseUrl);
    const authServerMetadata = await discoverAuthorizationServerMetadata(origin);

    if (authServerMetadata) {
      const supportsDcr = !!authServerMetadata.registration_endpoint;
      const capabilities: AuthCapabilities = { supportsDcr };

      if (authServerMetadata.registration_endpoint) {
        capabilities.registrationEndpoint = authServerMetadata.registration_endpoint;
      }
      if (authServerMetadata.authorization_endpoint) {
        capabilities.authorizationEndpoint = authServerMetadata.authorization_endpoint;
      }
      if (authServerMetadata.token_endpoint) capabilities.tokenEndpoint = authServerMetadata.token_endpoint;
      if (authServerMetadata.introspection_endpoint) {
        capabilities.introspectionEndpoint = authServerMetadata.introspection_endpoint;
      }
      if (authServerMetadata.scopes_supported) capabilities.scopes = authServerMetadata.scopes_supported;

      return capabilities;
    }

    // No OAuth metadata found
    return { supportsDcr: false };
  } catch (_error) {
    // Network error, invalid JSON, or other fetch failure
    // Gracefully degrade - assume no DCR support
    return { supportsDcr: false };
  }
}
