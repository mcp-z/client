/**
 * connect-mcp-client.ts
 *
 * Helper to connect MCP SDK clients to servers with intelligent transport inference.
 * Automatically detects transport type from URL protocol or type field.
 */

import '../monkey-patches.ts';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import getPort from 'get-port';
import { probeAuthCapabilities } from '../auth/index.ts';
import { DcrAuthenticator, type DcrAuthenticatorOptions } from '../dcr/index.ts';
import type { ServerProcess } from '../spawn/spawn-server.ts';
import type { ServersConfig } from '../spawn/spawn-servers.ts';

/**
 * Minimal interface for connecting to servers.
 * Only needs config and servers map for connection logic.
 */
interface RegistryLike {
  config: ServersConfig;
  servers: Map<string, ServerProcess>;
}

import type { McpServerEntry, TransportType } from '../types.ts';
import { logger as defaultLogger, type Logger } from '../utils/logger.ts';
import { ExistingProcessTransport } from './existing-process-transport.ts';
import { waitForHttpReady } from './wait-for-http-ready.ts';

/**
 * Wrap promise with timeout - throws if promise takes too long
 * Clears timeout when promise completes to prevent hanging event loop
 * @param promise - Promise to wrap
 * @param ms - Timeout in milliseconds
 * @param operation - Description of operation for error message
 * @returns Promise result or timeout error
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${operation}`)), ms);
    }),
  ]);
}

/**
 * Extract base URL from MCP server URL
 * @param mcpUrl - Full MCP endpoint URL (e.g., https://example.com/mcp)
 * @returns Base URL (e.g., https://example.com)
 */
function extractBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  return `${url.protocol}//${url.host}`;
}

/**
 * Infer transport type from server configuration with validation.
 *
 * Priority:
 * 1. Explicit type field (if present)
 * 2. URL protocol (if URL present): http://, https://
 * 3. Default to 'stdio' (if neither present)
 *
 * @param config - Server configuration
 * @returns Transport type
 * @throws Error if configuration is invalid or has conflicts
 */
function inferTransportType(config: McpServerEntry): TransportType {
  // Priority 1: Explicit type field
  if (config.type) {
    // Validate consistency with URL if both present
    if (config.url) {
      const url = new URL(config.url);
      const protocol = url.protocol;

      if ((protocol === 'http:' || protocol === 'https:') && config.type !== 'http' && config.type !== 'sse-ide') {
        throw new Error(`Conflicting transport: URL protocol '${protocol}' requires type 'http', but got '${config.type}'`);
      }
    }

    // Return normalized type
    if (config.type === 'http' || config.type === 'sse-ide') return 'http';
    if (config.type === 'stdio') return 'stdio';

    throw new Error(`Unsupported transport type: ${config.type}`);
  }

  // Priority 2: Infer from URL protocol
  if (config.url) {
    const url = new URL(config.url);
    const protocol = url.protocol;

    if (protocol === 'http:' || protocol === 'https:') {
      return 'http';
    }
    throw new Error(`Unsupported URL protocol: ${protocol}`);
  }

  // Priority 3: Default to stdio
  return 'stdio';
}

/**
 * Connect MCP SDK client to server with full readiness handling.
 * @internal - Use registry.connect() instead
 *
 * **Completely handles readiness**: transport availability + MCP protocol handshake.
 *
 * Transport is intelligently inferred and handled:
 * - **Stdio servers**: Direct MCP connect (fast for spawned processes)
 * - **HTTP servers**: Transport polling (/mcp endpoint) + MCP connect
 * - **Registry result**: Handles both spawned and external servers
 *
 * Returns only when server is fully MCP-ready (initialize handshake complete).
 *
 * @param registryOrConfig - Result from createServerRegistry() or servers config object
 * @param serverName - Server name from servers config
 * @returns Connected MCP SDK Client (guaranteed ready)
 *
 * @example
 * // Using registry (recommended)
 * const registry = createServerRegistry({ echo: { command: 'node', args: ['server.ts'] } });
 * const client = await registry.connect('echo');
 * // Server is fully ready - transport available + MCP handshake complete
 *
 * @example
 * // HTTP server readiness (waits for /mcp polling + MCP handshake)
 * const registry = createServerRegistry(
 *   { http: { type: 'http', url: 'http://localhost:3000/mcp', start: {...} } },
 *   { dialects: ['start'] }
 * );
 * const client = await registry.connect('http');
 * // 1. Waits for HTTP server to respond on /mcp
 * // 2. Performs MCP initialize handshake
 * // 3. Returns ready client
 */
export async function connectMcpClient(
  registryOrConfig: RegistryLike | ServersConfig,
  serverName: string,
  options?: {
    dcrAuthenticator?: Partial<DcrAuthenticatorOptions>;
    logger?: Logger;
  }
): Promise<Client> {
  // Detect whether we have a RegistryLike instance or just config
  const isRegistry = 'servers' in registryOrConfig && registryOrConfig.servers instanceof Map;
  const serversConfig = isRegistry ? (registryOrConfig as RegistryLike).config : registryOrConfig;
  const registry = isRegistry ? (registryOrConfig as RegistryLike) : undefined;
  const logger = options?.logger ?? defaultLogger;

  const serverConfig = serversConfig[serverName];

  if (!serverConfig) {
    const available = Object.keys(serversConfig).join(', ');
    throw new Error(`Server '${serverName}' not found in config. Available servers: ${available || 'none'}`);
  }

  // Infer transport type with validation
  const transportType = inferTransportType(serverConfig);

  // Create MCP client
  const client = new Client({ name: 'mcp-cli-client', version: '1.0.0' }, { capabilities: {} });

  // Connect based on inferred transport
  if (transportType === 'stdio') {
    // Check if we have a spawned process in the registry
    const serverHandle = registry?.servers.get(serverName);

    if (serverHandle) {
      // Reuse the already-spawned process
      const transport = new ExistingProcessTransport(serverHandle.process);
      await client.connect(transport);
    } else {
      // No registry or server not in registry - spawn new process directly
      // This is the standard fallback when process management is not used
      if (!serverConfig.command) {
        throw new Error(`Server '${serverName}' has stdio transport but missing 'command' field`);
      }

      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env || {},
      });

      // client.connect() performs initialize handshake - when it resolves, server is ready
      await client.connect(transport);
    }
  } else if (transportType === 'http') {
    if (!('url' in serverConfig) || !serverConfig.url) {
      throw new Error(`Server '${serverName}' has http transport but missing 'url' field`);
    }

    // Check if this is a freshly spawned HTTP server (from registry)
    // that might not be ready yet - transport readiness check needed
    const isSpawnedHttp = registry?.servers.has(serverName);

    if (isSpawnedHttp) {
      logger.debug(`[connectMcpClient] waiting for HTTP server '${serverName}' at ${serverConfig.url}`);
      await waitForHttpReady(serverConfig.url);
      logger.debug(`[connectMcpClient] HTTP server '${serverName}' ready`);
    }

    const url = new URL(serverConfig.url);

    // Check for DCR support and handle authentication automatically
    const baseUrl = extractBaseUrl(serverConfig.url);
    const capabilities = await withTimeout(probeAuthCapabilities(baseUrl), 5000, 'DCR capability discovery');

    let authToken: string | undefined;

    if (capabilities.supportsDcr) {
      logger.debug(`🔐 Server '${serverName}' supports DCR authentication`);

      // Get available port and create the exact redirect URI to use
      const port = await getPort();
      const redirectUri = `http://localhost:${port}/callback`;

      // Handle authentication using DcrAuthenticator with fully resolved redirectUri
      const authenticator = new DcrAuthenticator({
        headless: false,
        redirectUri,
        logger,
        ...options?.dcrAuthenticator,
      });

      // Ensure we have valid tokens (performs DCR + OAuth if needed)
      const tokens = await authenticator.ensureAuthenticated(baseUrl, capabilities);
      authToken = tokens.accessToken;

      logger.debug(`✅ Authentication complete for '${serverName}'`);
    } else {
      logger.debug(`ℹ️  Server '${serverName}' does not support DCR - connecting without authentication`);
    }

    try {
      // Try modern Streamable HTTP first (protocol version 2025-03-26)
      // Merge static headers from config with DCR auth headers (DCR Authorization takes precedence)
      const staticHeaders = serverConfig.headers || {};
      const dcrHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const mergedHeaders = { ...staticHeaders, ...dcrHeaders };

      const transportOptions =
        Object.keys(mergedHeaders).length > 0
          ? {
              requestInit: {
                headers: mergedHeaders,
              },
            }
          : undefined;

      const transport = new StreamableHTTPClientTransport(url, transportOptions);
      // Type assertion: SDK transport has sessionId: string | undefined but Transport expects string
      // This is safe at runtime - the undefined is valid per MCP spec
      await withTimeout(client.connect(transport as unknown as Transport), 30000, 'StreamableHTTP connection');
    } catch (error) {
      // Fall back to SSE transport (MCP protocol version 2024-11-05)
      // SSE is a standard MCP transport used by many servers (e.g., FastMCP ecosystem)
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Fast-fail: Don't try SSE if connection was refused (server not running)
      // Check error.cause.code for ECONNREFUSED (fetch errors wrap the actual error in cause)
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
      const isConnectionRefused = cause?.code === 'ECONNREFUSED' || errorMessage.includes('Connection refused');

      if (isConnectionRefused) {
        // Clean up client resources before throwing
        await client.close().catch(() => {});
        throw new Error(`Server not running at ${url}`);
      }

      // Check for known errors that indicate SSE fallback is needed
      const shouldFallback =
        errorMessage.includes('Missing session ID') || // FastMCP specific
        errorMessage.includes('404') || // Server doesn't have streamable HTTP endpoint
        errorMessage.includes('405'); // Method not allowed

      if (shouldFallback) {
        logger.warn(`Streamable HTTP failed (${errorMessage}), falling back to SSE transport`);
      } else {
        logger.warn('Streamable HTTP connection failed, trying SSE transport as fallback');
      }

      // Create new client for SSE transport (required per SDK pattern)
      const sseClient = new Client({ name: 'mcp-cli-client', version: '1.0.0' }, { capabilities: {} });

      // SSE transport with merged headers (static + DCR auth)
      // Reuse the same header merging logic as Streamable HTTP
      const staticHeaders = serverConfig.headers || {};
      const dcrHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const mergedHeaders = { ...staticHeaders, ...dcrHeaders };

      const sseTransportOptions =
        Object.keys(mergedHeaders).length > 0
          ? {
              requestInit: {
                headers: mergedHeaders,
              },
            }
          : undefined;

      const sseTransport = new SSEClientTransport(url, sseTransportOptions);

      try {
        await withTimeout(sseClient.connect(sseTransport), 30000, 'SSE connection');
        // Return SSE client instead of original
        return sseClient;
      } catch (sseError) {
        // SSE connection failed - clean up both clients before throwing
        await Promise.all([client.close().catch(() => {}), sseClient.close().catch(() => {})]);
        throw sseError;
      }
    }
  }

  return client; // Guaranteed ready when returned
}
