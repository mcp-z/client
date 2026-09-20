/**
 * High-level multi-server registry management.
 * Starts multiple servers from a servers configuration object.
 * Supports stdio, http, and ws transports.
 * Implements Claude Code-compatible configuration with start extension support.
 */

import type { VersionNegotiationOptions } from '@modelcontextprotocol/client';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { decorateClient, type ManagedClient } from '../client-helpers.ts';
import { validateServers } from '../config/validate-config.ts';
import { connectMcpClient } from '../connection/connect-client.ts';
import type { DcrAuthenticatorOptions } from '../dcr/dcr-authenticator.ts';
import { buildCapabilityIndex, type CapabilityClient, searchCapabilities as executeCapabilitySearch, type SearchOptions, type SearchResponse } from '../search/index.ts';
import type { McpServerEntry, StartConfig, StopCommandConfig, TransportType } from '../types.ts';
import { type Logger, logger } from '../utils/logger.ts';
import { type ServerProcess, spawnProcess } from './spawn-server.ts';

/**
 * Servers configuration type - a map of server names to their configurations.
 */
export type ServersConfig = Record<string, McpServerEntry>;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withCause(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ settled: true; value: T } | { settled: true; error: unknown } | { settled: false }> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(
      (value) => ({ settled: true as const, value }),
      (error: unknown) => ({ settled: true as const, error })
    ),
    new Promise<{ settled: false }>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Dialect for server spawning.
 *
 * - 'servers': Spawn stdio servers (Claude Code compatible)
 * - 'start': Spawn HTTP servers with start blocks
 */
export type Dialect = 'servers' | 'start';

type RegistryConnectOptions = Omit<NonNullable<Parameters<typeof connectMcpClient>[2]>, 'signal'>;

/**
 * Options for creating a server registry.
 */
export interface CreateServerRegistryOptions {
  /** Working directory for spawned processes (default: process.cwd()) */
  cwd?: string;

  /**
   * Base environment for all servers.
   * If provided, process.env is NOT included (caller has full control).
   * If omitted, process.env is used as the base (default behavior).
   */
  env?: Record<string, string>;

  /**
   * Dialects controlling which servers to spawn.
   * - ['servers']: Spawn stdio servers only (default, Claude Code compatible)
   * - ['start']: Only spawn servers with start blocks (HTTP servers)
   * - ['servers', 'start']: Spawn both stdio servers and start blocks
   * @default ['servers']
   */
  dialects?: Dialect[];
}

/**
 * Result of closing the registry.
 */
export interface CloseResult {
  /** Whether any owned process exceeded its cooperative shutdown timeout */
  timedOut: boolean;
  /** Number of owned processes that required emergency force termination */
  killedCount: number;
}

/**
 * Infer transport type: explicit type > URL protocol > default 'stdio'
 */
function inferTransportType(config: { type?: TransportType; url?: string }): TransportType {
  if (config.type) {
    return config.type;
  }

  if (config.url) {
    const url = new URL(config.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return 'http';
    }
  }

  return 'stdio';
}

/**
 * Spawn configuration result (internal)
 */
interface SpawnConfig {
  shouldSpawn: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stop?: StopCommandConfig;
}

/**
 * Helper to filter undefined values from environment
 */
function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function getStartSpawnConfig(start: StartConfig, transportType: TransportType, baseEnv: Record<string, string | undefined>): SpawnConfig {
  const stop =
    start.stop && (transportType === 'http' || transportType === 'sse-ide')
      ? {
          ...start.stop,
          cwd: start.stop.cwd,
          env: filterEnv({ ...baseEnv, ...start.env, ...start.stop.env }),
        }
      : undefined;

  return {
    shouldSpawn: true,
    command: start.command,
    args: start.args || [],
    env: filterEnv({ ...baseEnv, ...start.env }),
    cwd: start.cwd,
    ...(stop && { stop }),
  };
}

/**
 * Determine spawn behavior based on dialects and config structure.
 *
 * Dialects:
 * - ['servers'] (default): Claude Code compatible - ignores start blocks, stdio only
 * - ['start']: Only spawn servers with start blocks (HTTP server testing)
 * - ['servers', 'start']: Spawn both start blocks and stdio servers (full MCP-Z extension support)
 *
 * Environment merging (when baseEnv provided):
 * - HTTP servers (start block): { ...baseEnv, ...entry.start.env }
 * - Stdio servers: { ...baseEnv, ...entry.env }
 *
 * When baseEnv is not provided, process.env is used as the base.
 */
function getSpawnConfig(entry: McpServerEntry, dialects: Dialect[], baseEnv: Record<string, string | undefined>): SpawnConfig {
  const transportType = inferTransportType(entry);
  if (dialects.length === 0) {
    return { shouldSpawn: false };
  }

  const hasServers = dialects.includes('servers');
  const hasStart = dialects.includes('start');

  // If only 'servers' dialect: Claude Code compatible (ignore start blocks, stdio only)
  if (hasServers && !hasStart) {
    if (transportType === 'stdio' && entry.command) {
      return {
        shouldSpawn: true,
        command: entry.command,
        args: entry.args || [],
        env: filterEnv({ ...baseEnv, ...entry.env }),
      };
    }
    return { shouldSpawn: false };
  }

  // If only 'start' dialect: Only spawn servers with start blocks
  if (hasStart && !hasServers) {
    if (entry.start) {
      return getStartSpawnConfig(entry.start, transportType, baseEnv);
    }
    return { shouldSpawn: false };
  }

  // Both dialects: Spawn both start blocks and stdio servers
  // Priority: start blocks first, then stdio
  if (entry.start) {
    return getStartSpawnConfig(entry.start, transportType, baseEnv);
  }

  if (transportType === 'stdio' && entry.command) {
    return {
      shouldSpawn: true,
      command: entry.command,
      args: entry.args || [],
      env: filterEnv({ ...baseEnv, ...entry.env }),
    };
  }

  return { shouldSpawn: false };
}

/**
 * A registry of spawned MCP servers with connection management.
 * Provides access to individual server handles, connection management, and collection-wide close.
 */
export interface ServerRegistry {
  /**
   * The resolved servers configuration that was used.
   * Useful for debugging and understanding what was started.
   */
  config: ServersConfig;

  /**
   * Map of server name to server process handle.
   * @hidden
   */
  servers: Map<string, ServerProcess>;

  /**
   * Set of connected clients tracked by this registry.
   * Automatically populated when using registry.connect().
   */
  clients: Set<ManagedClient>;

  /**
   * Connect to a server by name.
   * The connected client is automatically tracked for close.
   *
   * @param name - Server name from configuration
   * @param options - Authentication, logging, and protocol negotiation options
   * @returns Connected MCP SDK Client
   */
  connect: (name: string, options?: { dcrAuthenticator?: Partial<DcrAuthenticatorOptions>; logger?: Logger; versionNegotiation?: VersionNegotiationOptions }) => Promise<ManagedClient>;

  /**
   * Close all clients and servers gracefully.
   * Stops new connections, waits for in-flight connections, closes tracked clients, and then
   * stops only processes owned by this registry. Stdio children receive stdin EOF first
   * and the requested signal on POSIX if they remain open; owned HTTP children may use
   * their configured application-specific stop command. POSIX cleanup tracks the detached
   * process group; Windows can terminate only the direct child and cannot verify descendants.
   * Cleanup failures are reported after every owned resource has been attempted.
   *
   * @param signal - Signal to send to processes (default: SIGINT)
   * @param opts - Options including timeout
   * @returns Promise resolving to whether any process timed out and how many required emergency force termination
   */
  close: (signal?: NodeJS.Signals, opts?: { timeoutMs?: number }) => Promise<CloseResult>;

  /**
   * Search indexed capabilities across all currently connected clients.
   * Requires at least one connected client; respects SearchOptions filters.
   */
  searchCapabilities: (query: string, options?: SearchOptions) => Promise<SearchResponse>;

  /**
   * Support for `await using` pattern (automatic close).
   */
  [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Create a registry of MCP servers from configuration.
 *
 * **Fast start**: Returns immediately after processes are created.
 * Use `registry.connect()` for lazy MCP connection.
 *
 * @param serversConfig - Map of server names to their configurations
 * @param options - Options for registry creation
 * @param options.cwd - Working directory for spawned processes (default: process.cwd())
 * @param options.env - Base environment for all servers. If provided, process.env is NOT included.
 *                      If omitted, process.env is used as the base (default behavior).
 * @param options.dialects - Dialects controlling which servers to spawn (default: ['servers'])
 *   - ['servers']: Spawn stdio servers only (Claude Code compatible)
 *   - ['start']: Only spawn servers with start blocks (HTTP servers)
 *   - ['servers', 'start']: Spawn both stdio servers and start blocks
 * @returns ServerRegistry instance with config, server map, connect method, and close function
 *
 * @example
 * // Fast server start (does NOT wait for readiness)
 * const registry = createServerRegistry({
 *   'echo': { command: 'node', args: ['server.ts'] },
 * });
 *
 * // Connect when needed (waits for MCP handshake)
 * const client = await registry.connect('echo');
 *
 * // Cleanup (closes all clients AND processes)
 * await registry.close();
 *
 * @example
 * // Start HTTP servers with start blocks
 * const registry = createServerRegistry(
 *   {
 *     'http-server': {
 *       url: 'http://localhost:8080/mcp',
 *       start: { command: 'node', args: ['http.ts', '--port', '8080'] }
 *     },
 *   },
 *   { dialects: ['start'] }
 * );
 *
 * @example
 * // Using await using for automatic close
 * await using registry = createServerRegistry(config);
 * const client = await registry.connect('server');
 * // Auto-disposed when scope exits
 */
export function createServerRegistry(serversConfig: ServersConfig, options?: CreateServerRegistryOptions): ServerRegistry {
  const cwd = options?.cwd ?? process.cwd();
  const dialects = options?.dialects ?? ['servers'];

  // Determine base environment:
  // - If options.env provided, use it (process.env NOT included)
  // - If options.env omitted, use process.env as base
  const baseEnv: Record<string, string | undefined> = options?.env ?? process.env;

  // Validate working directory exists (fail fast for configuration errors)
  if (!fs.existsSync(cwd)) {
    throw new Error(`Cannot start servers: working directory '${cwd}' does not exist`);
  }

  // Validate configuration (fail fast with clear errors)
  const validation = validateServers(serversConfig);
  if (!validation.valid) {
    throw new Error(`Invalid servers configuration:\n${validation.errors?.join('\n') ?? 'Unknown validation error'}`);
  }

  // Log validation warnings (non-blocking)
  if (validation.warnings && validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      logger.warn(warning);
    }
  }

  const servers = new Map<string, ServerProcess>();
  const clients = new Set<ManagedClient>();
  const sharedStdioClients = new Map<string, { client?: ManagedClient; connecting?: Promise<ManagedClient>; refs: number }>();
  const pendingConnects = new Set<Promise<ManagedClient>>();
  const closeAbortController = new AbortController();
  const clientClosePromises = new WeakMap<ManagedClient, Promise<void>>();
  const closeRaceErrors: Error[] = [];
  let lifecycleState: 'open' | 'closing' | 'closed' = 'open';
  let closePromise: Promise<CloseResult> | undefined;

  const closeClientOnce = (client: ManagedClient): Promise<void> => {
    let pending = clientClosePromises.get(client);
    if (!pending) {
      pending = Promise.resolve().then(() => client.close());
      clientClosePromises.set(client, pending);
    }
    return pending;
  };

  // Start each server in the configuration
  for (const [name, entry] of Object.entries(serversConfig)) {
    // Infer transport type from config
    const transportType = inferTransportType(entry);

    // Determine spawn behavior based on dialects
    const spawnConfig = getSpawnConfig(entry, dialects, baseEnv);

    // Check if we should spawn this server
    if (!spawnConfig.shouldSpawn) {
      // External server - just log, no spawn needed
      if (entry.url) {
        logger.info(`[${name}] external ${transportType} server (url: ${entry.url})`);
      } else {
        logger.warn(`[${name}] skipping: no spawn configuration (missing start or command) and no url for external server`);
      }
      continue;
    }

    try {
      // Validate spawn config
      if (!spawnConfig.command) {
        throw new Error(`Server "${name}" missing command field`);
      }

      const resolvedCwd = spawnConfig.cwd ? path.resolve(cwd, spawnConfig.cwd) : cwd;

      // Start the server
      logger.info(`[${name}] starting ${transportType} server (${spawnConfig.command} ${(spawnConfig.args || []).join(' ')})`);

      // stdio servers need 'pipe' for MCP communication over stdin/stdout
      // network servers use 'inherit' so we see their logs
      const stdio = transportType === 'stdio' ? 'pipe' : 'inherit';

      const handle = spawnProcess({
        name,
        command: spawnConfig.command,
        ...(spawnConfig.args !== undefined && { args: spawnConfig.args }),
        cwd: resolvedCwd,
        ...(spawnConfig.env && Object.keys(spawnConfig.env).length > 0 && { env: spawnConfig.env }),
        inheritEnv: options?.env === undefined,
        ...(spawnConfig.stop && { stop: { ...spawnConfig.stop, cwd: spawnConfig.stop.cwd ? path.resolve(resolvedCwd, spawnConfig.stop.cwd) : resolvedCwd } }),
        stdio,
      });

      // Add server to registry (starting is fast, readiness is lazy)
      servers.set(name, handle);
      logger.info(`[${name}] started successfully`);
    } catch (e) {
      logger.info(`[${name}] start ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Connect internally, then track each returned lease for registry shutdown.
  const connectInternal = async (name: string, options?: RegistryConnectOptions): Promise<ManagedClient> => {
    const serverEntry = serversConfig[name];
    if (!serverEntry) {
      const available = Object.keys(serversConfig).join(', ');
      throw new Error(`Server '${name}' not found in config. Available servers: ${available || 'none'}`);
    }

    const transportType = inferTransportType(serverEntry);

    if (transportType === 'stdio') {
      // Stdio is a single logical connection; reuse one client and lease references.
      let entry = sharedStdioClients.get(name);
      if (!entry) {
        entry = { refs: 0 };
        sharedStdioClients.set(name, entry);
      }

      if (!entry.client) {
        if (!entry.connecting) {
          entry.connecting = (async () => {
            // Pass minimal RegistryLike object to connectMcpClient
            const registryLike = { config: serversConfig, servers };
            const rawClient = await connectMcpClient(registryLike, name, { ...options, signal: closeAbortController.signal });
            const decorated = decorateClient(rawClient, { serverName: name });
            entry.client = decorated;
            entry.connecting = undefined;
            return decorated;
          })().catch((error) => {
            sharedStdioClients.delete(name);
            throw error;
          });
        }

        await entry.connecting;
      }

      if (!entry.client) {
        throw new Error(`Failed to connect to stdio server '${name}'`);
      }

      entry.refs += 1;
      let releasePromise: Promise<void> | undefined;
      let lease: ManagedClient;

      lease = new Proxy(entry.client, {
        get(target, prop) {
          if (prop === 'close') {
            return () => {
              releasePromise ??= (async () => {
                entry.refs = Math.max(0, entry.refs - 1);
                try {
                  if (entry.refs === 0) {
                    sharedStdioClients.delete(name);
                    await target.close();
                  }
                } finally {
                  clients.delete(lease);
                }
              })();
              return releasePromise;
            };
          }

          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value === 'function') {
            return (value as (...args: unknown[]) => unknown).bind(target);
          }
          return value;
        },
      }) as ManagedClient;

      clients.add(lease);
      return lease;
    }

    // Pass minimal RegistryLike object to connectMcpClient
    const registryLike = { config: serversConfig, servers };
    const rawClient = await connectMcpClient(registryLike, name, { ...options, signal: closeAbortController.signal });
    const decorated = decorateClient(rawClient, { serverName: name });
    clients.add(decorated);
    return decorated;
  };

  const connect = (name: string, options?: RegistryConnectOptions): Promise<ManagedClient> => {
    if (lifecycleState !== 'open') {
      return Promise.reject(new Error(`Cannot connect to server '${name}': registry is ${lifecycleState}`));
    }

    const pending = connectInternal(name, options).then(async (client) => {
      if (lifecycleState === 'open') return client;

      const result = await settleWithin(closeClientOnce(client), DEFAULT_SHUTDOWN_TIMEOUT_MS);
      if (!result.settled) closeRaceErrors.push(new Error(`Client for server '${name}' did not close within ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms after a connection raced registry shutdown`));
      else if ('error' in result) closeRaceErrors.push(withCause(`Failed to close server '${name}' after a connection raced registry shutdown`, asError(result.error)));
      throw new Error(`Connection to server '${name}' completed while the registry was closing`);
    });

    pendingConnects.add(pending);
    void pending.then(
      () => pendingConnects.delete(pending),
      () => pendingConnects.delete(pending)
    );
    return pending;
  };

  const closeAll = async (signal: NodeJS.Signals, opts: { timeoutMs?: number }): Promise<CloseResult> => {
    logger.info(`[registry] closing (${signal})`);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const errors: Error[] = [];
    closeAbortController.abort(new Error('Server registry is closing'));

    const pendingResult = await settleWithin(Promise.allSettled(Array.from(pendingConnects)), timeoutMs);
    if (!pendingResult.settled) {
      errors.push(new Error(`In-flight server connections did not settle within ${timeoutMs}ms after cancellation`));
    }
    errors.push(...closeRaceErrors);

    // Client close can hang independently; bound it so every owned server still gets cleanup.
    const clientEntries = Array.from(clients);
    const clientResults = await Promise.all(clientEntries.map(async (client) => ({ client, result: await settleWithin(closeClientOnce(client), timeoutMs) })));
    for (const { client, result } of clientResults) {
      if (!result.settled) {
        errors.push(new Error(`Client${client.serverName ? ` for server '${client.serverName}'` : ''} did not close within ${timeoutMs}ms`));
      } else if ('error' in result) {
        errors.push(withCause(`Failed to close client${client.serverName ? ` for server '${client.serverName}'` : ''}: ${asError(result.error).message}`, asError(result.error)));
      }
    }
    clients.clear();
    sharedStdioClients.clear();

    // Server teardown runs even when pending connects or client closes failed.
    const serverEntries = Array.from(servers.entries());
    const serverResults = await Promise.all(
      serverEntries.map(async ([name, server]) => {
        try {
          return { name, result: await server.close(signal, opts) };
        } catch (error) {
          return { name, error: asError(error) };
        }
      })
    );

    let timedOut = false;
    let killedCount = 0;
    for (const result of serverResults) {
      if ('error' in result && result.error !== undefined) {
        errors.push(withCause(`Failed to close server '${result.name}': ${result.error.message}`, result.error));
      } else if ('result' in result) {
        timedOut ||= result.result.timedOut;
        if (result.result.killed) killedCount += 1;
      }
    }

    lifecycleState = 'closed';
    if (errors.length > 0) {
      const details = errors.map((error) => error.message).join('; ');
      throw new AggregateError(errors, `Registry shutdown completed with ${errors.length} cleanup failure(s): ${details}`);
    }

    return { timedOut, killedCount };
  };

  const close = (signal: NodeJS.Signals = 'SIGINT', opts: { timeoutMs?: number } = {}): Promise<CloseResult> => {
    if (!closePromise) {
      lifecycleState = 'closing';
      closePromise = closeAll(signal, opts);
    }
    return closePromise;
  };

  const searchFromRegistry = async (query: string, options: SearchOptions = {}): Promise<SearchResponse> => {
    const requestedServers = options.servers ?? Object.keys(serversConfig);
    if (requestedServers.length === 0) {
      throw new Error('Cannot search capabilities: registry has no configured servers');
    }

    const unknownServers = requestedServers.filter((name) => !(name in serversConfig));
    if (unknownServers.length > 0) {
      throw new Error(`Cannot search capabilities: unknown server(s) [${unknownServers.join(', ')}]`);
    }

    const capabilityClients = new Map<string, CapabilityClient>();
    const failures: Array<{ server: string; reason: string }> = [];

    const ensureClient = async (serverName: string): Promise<ManagedClient> => {
      for (const client of clients) {
        if (client.serverName === serverName) {
          return client;
        }
      }
      return connect(serverName);
    };

    await Promise.all(
      requestedServers.map(async (serverName) => {
        try {
          const managed = await ensureClient(serverName);
          capabilityClients.set(serverName, managed.nativeClient);
        } catch (error) {
          failures.push({
            server: serverName,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    if (capabilityClients.size === 0) {
      const failureDetails = failures.length > 0 ? ` Connection failures: ${failures.map((f) => `${f.server} (${f.reason})`).join('; ')}` : '';
      throw new Error(`Cannot search capabilities: unable to connect to any requested servers.${failureDetails}`);
    }

    if (failures.length > 0) {
      throw new Error(`Cannot search capabilities: failed to connect to server(s) [${failures.map((f) => f.server).join(', ')}]. Reasons: ${failures.map((f) => `${f.server}: ${f.reason}`).join('; ')}`);
    }

    const index = await buildCapabilityIndex(capabilityClients);
    return executeCapabilitySearch(index, query, options);
  };

  // Async dispose for `await using` pattern
  const asyncDispose = async (): Promise<void> => {
    await close();
  };

  return {
    config: serversConfig,
    servers,
    clients,
    connect,
    close,
    searchCapabilities: searchFromRegistry,
    [Symbol.asyncDispose]: asyncDispose,
  };
}
