/**
 * connect-mcp-client.ts
 *
 * Helper to connect MCP SDK clients to servers with intelligent transport inference.
 * Automatically detects transport type from URL protocol or type field.
 */

import type { AuthProvider, ClientOptions, Implementation, Transport, VersionNegotiationOptions } from '@modelcontextprotocol/client';
import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { probeAuthCapabilities } from '../auth/index.ts';
import { DCR_CAPABILTY_DISCOVERY_TIMEOUT, LEGACY_CLIENT_INFO } from '../constants.ts';
import type { DcrAuthenticatorOptions } from '../dcr/index.ts';
import { SignIn } from '../dcr/sign-in.ts';
import { normalizeUrl } from '../lib/url-utils.ts';
import type { ServerProcess } from '../spawn/spawn-server.ts';
import type { ServersConfig } from '../spawn/spawn-servers.ts';

/** What a client sends about itself in `initialize`: the MCP Implementation (`name`, `version` and the optional `title`, `websiteUrl`, `icons`), sent as given. */
export type ClientInfo = Implementation;

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

const HTTP_CONNECTION_TIMEOUT_MS = 30_000;
const CLIENT_CLEANUP_TIMEOUT_MS = 5_000;

/** @internal - Bounds work by aborting the actual request signal at the deadline. */
export async function withAbortTimeout<T>(operationFn: (signal: AbortSignal) => Promise<T>, ms: number, operation: string, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`Timeout after ${ms}ms: ${operation}`);
  const abortFromParent = (): void => controller.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error('Connection was cancelled'));
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  if (parentSignal?.aborted) abortFromParent();
  const timeoutId = setTimeout(() => controller.abort(timeoutError), ms);

  try {
    // Preserve the operation's error unchanged: connection cleanup may have
    // attached failures to the original cancellation or timeout.
    return await operationFn(controller.signal);
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

/** @internal - Connects a transport with a deadline that aborts and cleans up the actual connection. */
export async function connectTransportWithTimeout(client: Client, transport: Transport, ms: number, operation: string, parentSignal?: AbortSignal): Promise<void> {
  return withAbortTimeout((signal) => connectTransport(client, transport, signal), ms, operation, parentSignal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Connection was cancelled');
}

async function closeClientWithinTimeout(client: Client): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Client cleanup did not complete within ${CLIENT_CLEANUP_TIMEOUT_MS}ms`)), CLIENT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function rethrowAfterClientCleanup(error: unknown, clients: Client[], message: string): Promise<never> {
  const cleanup = await Promise.allSettled(clients.map((client) => closeClientWithinTimeout(client)));
  const cleanupErrors = cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], message, { cause: error });
  throw error;
}

/** @internal - Connects one client/transport pair and reports any failed cleanup. */
export async function connectTransport(client: Client, transport: Transport, signal?: AbortSignal): Promise<void> {
  let abortHandler: (() => void) | undefined;
  try {
    throwIfAborted(signal);
    const connecting = client.connect(transport);
    if (signal) {
      const aborted = new Promise<never>((_, reject) => {
        abortHandler = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Connection was cancelled'));
        signal.addEventListener('abort', abortHandler, { once: true });
      });
      await Promise.race([connecting, aborted]);
    } else {
      await connecting;
    }
  } catch (error) {
    await rethrowAfterClientCleanup(error, [client], 'MCP connection failed and client cleanup also failed');
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

/** Static headers from the config plus, when the server signs in, the provider that supplies the Authorization header. */
function httpTransportOptions(headers: Record<string, string> | undefined, authProvider: AuthProvider | undefined) {
  const options: { requestInit?: { headers: Record<string, string> }; authProvider?: AuthProvider } = {};
  if (headers && Object.keys(headers).length > 0) options.requestInit = { headers };
  if (authProvider) options.authProvider = authProvider;
  return Object.keys(options).length > 0 ? options : undefined;
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
 * @param options - Connection options (see below)
 * @param options.dcrAuthenticator - DCR authenticator options
 * @param options.logger - Logger for connection diagnostics
 * @param options.versionNegotiation - SDK protocol version negotiation (protocol revision
 *   2026-07-28 and later). Omitted by default, which keeps the SDK's `'legacy'` mode:
 *   the plain 2025 connect sequence. Pass `{ mode: 'auto' }` to probe the server and
 *   fall back to 2025 when it cannot serve the modern era, or `{ mode: { pin: '2026-07-28' } }`
 *   to require the pinned revision (a server that cannot serve it fails the connect with
 *   a typed era-negotiation error).
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
    versionNegotiation?: VersionNegotiationOptions;
    /**
     * What this client sends to the server in `initialize`, as given: your application's own `name` and real `version`, and optionally `title`, `websiteUrl` and `icons`.
     * Through a registry it overrides the registry's `clientInfo`. Legacy fallback: with neither, the client sends `mcp-cli-client` 1.0.0, and the next major removes that fallback and requires one.
     * A second connect to a stdio server the registry has already connected reuses the first connect's client, so its `clientInfo` is not sent again.
     */
    clientInfo?: ClientInfo;
    /** Cancels readiness, authentication, and transport connection work. */
    signal?: AbortSignal;
  }
): Promise<Client> {
  // Detect whether we have a RegistryLike instance or just config
  const isRegistry = 'servers' in registryOrConfig && registryOrConfig.servers instanceof Map;
  const serversConfig: ServersConfig = isRegistry ? (registryOrConfig as RegistryLike).config : (registryOrConfig as ServersConfig);
  const registry = isRegistry ? (registryOrConfig as RegistryLike) : undefined;
  const logger = options?.logger ?? defaultLogger;
  throwIfAborted(options?.signal);

  const serverConfig = serversConfig[serverName];

  if (!serverConfig) {
    const available = Object.keys(serversConfig).join(', ');
    throw new Error(`Server '${serverName}' not found in config. Available servers: ${available || 'none'}`);
  }

  // Infer transport type with validation
  const transportType = inferTransportType(serverConfig);

  // SDK client options for both transports (main + SSE fallback). versionNegotiation is
  // omitted rather than set to undefined so the default stays the SDK's 'legacy' mode —
  // the plain 2025 connect sequence — for callers that do not pass it.
  const clientOptions: ClientOptions = { capabilities: {} };
  if (options?.versionNegotiation !== undefined) {
    clientOptions.versionNegotiation = options.versionNegotiation;
  }

  // Create MCP client
  const clientInfo = options?.clientInfo ?? LEGACY_CLIENT_INFO;
  const client = new Client(clientInfo, clientOptions);
  // The client that ends up connected: the first one, or the one made after a transport signed in again.
  let connected = client;

  // Connect based on inferred transport
  if (transportType === 'stdio') {
    // Check if we have a spawned process in the registry
    const serverHandle = registry?.servers.get(serverName);

    if (serverHandle) {
      // Reuse the already-spawned process
      const transport = new ExistingProcessTransport(serverHandle.process);
      await connectTransport(client, transport, options?.signal);
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
      await connectTransport(client, transport, options?.signal);
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
      await waitForHttpReady(serverConfig.url, 30000, options?.signal);
      logger.debug(`[connectMcpClient] HTTP server '${serverName}' ready`);
    }

    const url = new URL(serverConfig.url);

    // Check for DCR support and handle authentication automatically
    // The canonical MCP server URI, path segment and all. Both calls below need
    // the server's identity, not its deployment root: discovery uses the path to
    // find resource-specific metadata (RFC 9728 sub-path), and the authenticator
    // audience-binds tokens to it (RFC 8707). Handing either the `/mcp`-stripped
    // base names a different resource, which authorization servers that validate
    // the `resource` indicator reject as `invalid_target`.
    const mcpServerUrl = normalizeUrl(serverConfig.url);
    const capabilities = await withAbortTimeout((signal) => probeAuthCapabilities(mcpServerUrl, { signal }), DCR_CAPABILTY_DISCOVERY_TIMEOUT, 'DCR capability discovery', options?.signal);

    let authProvider: AuthProvider | undefined;
    let signIn: SignIn | undefined;
    // Set once a transport has asked to sign in again: whatever follows is that sign-in's outcome, not a reason to try another transport.
    let signInAttempted = false;

    // A server that offers a client metadata document or dynamic registration gives the client a way to sign in.
    if (capabilities.supportsDcr || capabilities.supportsCimd) {
      logger.debug(`🔐 Server '${serverName}' supports OAuth sign-in`);

      // The callback binds 127.0.0.1 on a port the system assigns when a browser sign-in starts, unless the caller passes a redirectUri.
      const authenticator = new SignIn({
        headless: false,
        logger,
        ...options?.dcrAuthenticator,
      });

      // Ensure we have valid tokens (registers and signs in if needed)
      signIn = authenticator;
      await authenticator.ensureAuthenticated(mcpServerUrl, capabilities, options?.signal);
      // The transports read the token from it on every request and, on a 401, refresh it or sign in again.
      authProvider = authenticator.authProvider(mcpServerUrl, capabilities, options?.signal);

      logger.debug(`✅ Authentication complete for '${serverName}'`);
    } else {
      logger.debug(`ℹ️  Server '${serverName}' offers no way to sign in (no client metadata document, no registration) - connecting without authentication`);
    }

    /**
     * Connects, and when the server asked the transport to sign in again, finishes that sign-in (the user's browser step takes as long as it takes, so it
     * is outside the connection time limit) and connects once more with a new client and transport, as the SDK's UnauthorizedError sequence prescribes.
     */
    const connectWithSignIn = async (first: Client, makeTransport: () => Transport, operation: string): Promise<Client> => {
      if (signIn) signIn.connecting = true;
      try {
        await connectTransportWithTimeout(first, makeTransport(), HTTP_CONNECTION_TIMEOUT_MS, operation, options?.signal);
        return first;
      } catch (error) {
        if (!signIn || !UnauthorizedError.isInstance(error)) {
          await signIn?.discardPending();
          throw error;
        }
        signInAttempted = true;
        if (!(await signIn.completePending())) throw error;
        const retry = new Client(clientInfo, clientOptions);
        await connectTransportWithTimeout(retry, makeTransport(), HTTP_CONNECTION_TIMEOUT_MS, operation, options?.signal);
        return retry;
      } finally {
        if (signIn) signIn.connecting = false;
      }
    };
    try {
      // Try modern Streamable HTTP first (protocol version 2025-03-26)
      const transportOptions = httpTransportOptions(serverConfig.headers, authProvider);

      // Type assertion: SDK transport has sessionId: string | undefined but Transport expects string
      // This is safe at runtime - the undefined is valid per MCP spec
      connected = await connectWithSignIn(client, () => new StreamableHTTPClientTransport(url, transportOptions) as unknown as Transport, 'StreamableHTTP connection');
    } catch (error) {
      // Cancellation and cleanup failures must reach the caller; neither can
      // safely be converted into an SSE fallback attempt.
      if (options?.signal?.aborted || error instanceof AggregateError || signInAttempted) throw error;
      // Fall back to SSE transport (MCP protocol version 2024-11-05)
      // SSE is a standard MCP transport used by many servers (e.g., FastMCP ecosystem)
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Fast-fail: Don't try SSE if connection was refused (server not running)
      // Check error.cause.code for ECONNREFUSED (fetch errors wrap the actual error in cause)
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
      const isConnectionRefused = cause?.code === 'ECONNREFUSED' || errorMessage.includes('Connection refused');

      if (isConnectionRefused) {
        const unavailable = new Error(`Server not running at ${url}`, { cause: error });
        throw unavailable;
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
      const sseClient = new Client(clientInfo, clientOptions);

      // Return the SSE client instead of the original
      return await connectWithSignIn(sseClient, () => new SSEClientTransport(url, httpTransportOptions(serverConfig.headers, authProvider)), 'SSE connection');
    }
  }

  return connected; // Guaranteed ready when returned
}
