/**
 * Low-level single server spawning utilities.
 * Provides core process spawning with path resolution, environment management, and lifecycle control.
 */

import { type ChildProcess, type SpawnOptions, type StdioOptions, spawn } from 'child_process';
import * as process from 'process';
import { logger } from '../utils/logger.ts';
import { resolveArgsPaths } from '../utils/path-utils.ts';

/**
 * Options for spawning a single server process.
 * @internal
 */
export interface SpawnProcessOptions {
  /** Server name for logging */
  name: string;
  /** Command to execute (e.g., 'node', 'npx') */
  command: string;
  /** Command arguments (paths will be resolved relative to cwd) */
  args?: string[];
  /** Working directory (must be absolute path) */
  cwd?: string;
  /** Additional environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Standard I/O configuration */
  stdio?: StdioOptions;
  /** Use shell for command execution (default: false, true on Windows) */
  shell?: boolean;
}

/**
 * Handle to a spawned server process.
 * Provides access to the process, resolved config, and lifecycle control.
 * @hidden
 */
export interface ServerProcess {
  /**
   * The resolved server configuration that was actually used.
   * Useful for debugging and understanding what was spawned.
   */
  config: {
    name: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdio: StdioOptions;
    shell: boolean;
  };

  /**
   * The spawned child process.
   */
  process: ChildProcess;

  /**
   * Close the server gracefully.
   * Sends the specified signal (default: SIGINT), then SIGKILL after timeout.
   *
   * @param signal - Signal to send (default: SIGINT)
   * @param opts - Options including timeout
   * @returns Promise resolving to whether the process timed out and was force-killed
   */
  close: (signal?: NodeJS.Signals, opts?: { timeoutMs?: number }) => Promise<{ timedOut: boolean; killed: boolean }>;
}

/**
 * Normalize environment variables by merging with process.env and filtering undefined values.
 */
function normalizeEnv(env?: Record<string, string>): Record<string, string> {
  const merged = { ...process.env, ...(env || {}) };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Spawn a single server process with path resolution and environment management.
 *
 * @internal
 * @param opts - Server spawn options
 * @returns ServerProcess handle with resolved config, process, and stop function
 *
 * @example
 * const handle = spawnProcess({
 *   name: 'echo',
 *   command: 'node',
 *   args: ['./bin/server.js', '--port', '3000'],
 *   cwd: '/home/user/project/test/lib/servers/echo',
 *   env: { LOG_LEVEL: 'error' }
 * });
 *
 * // Later...
 * await handle.close();
 */
export function spawnProcess(opts: SpawnProcessOptions): ServerProcess {
  const name = opts.name;
  const command = opts.command;
  const cwd = opts.cwd ?? process.cwd();
  const stdio = opts.stdio ?? 'inherit';
  const shell = opts.shell ?? process.platform === 'win32';

  // Resolve paths in args relative to the working directory
  const args = opts.args ? resolveArgsPaths(opts.args, cwd) : [];

  // Merge environment variables
  const env = normalizeEnv(opts.env);

  // Create resolved config for return value
  const resolvedConfig = {
    name,
    command,
    args,
    cwd,
    env,
    stdio,
    shell,
  };

  // Log spawn operation
  logger.info(`[${name}] → ${command} ${args.join(' ')}`);

  // Spawn the process
  const spawnOpts: SpawnOptions = { cwd, env, stdio, shell };
  const child = spawn(command, args, spawnOpts);

  // Pipe stdio if not inherited
  if (child.stderr)
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

  // Attach lifecycle logging
  child.on('exit', (code, sig) => logger.info(`[${name}] exited (code=${code}, signal=${sig || 'none'})`));
  child.on('error', (err) => logger.info(`[${name}] process error: ${err.message}`));

  // Create stop function with graceful shutdown
  const stop = async (signal: NodeJS.Signals = 'SIGINT', opts: { timeoutMs?: number } = {}): Promise<{ timedOut: boolean; killed: boolean }> => {
    // If already exited, return immediately
    if (child.exitCode !== null || child.signalCode !== null) {
      return { timedOut: false, killed: false };
    }

    const timeoutMs = opts.timeoutMs ?? 500;

    // Wait for 'close' event (process exit + stdio streams closed)
    // This is better than 'exit' because it ensures stdio is fully cleaned up
    const closePromise = new Promise<{ timedOut: boolean; killed: boolean }>((resolve) => {
      let isResolved = false;
      let wasKilled = false;

      const resolveOnce = (timedOut: boolean) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeout);
        resolve({ timedOut, killed: wasKilled });
      };

      // Set timeout for forceful kill
      const timeout = setTimeout(() => {
        try {
          // Check again before SIGKILL
          if (child.exitCode === null && !child.killed) {
            child.kill('SIGKILL');
            wasKilled = true;
          }
        } catch (_) {}
        // Even if kill fails, resolve
        resolveOnce(true);
      }, timeoutMs);

      // Listen for 'close' event (not 'exit') to wait for stdio close
      child.once('close', () => {
        resolveOnce(false);
      });

      // Also listen for 'error' event in case spawn failed
      // This prevents promise from hanging forever if process never started
      child.once('error', () => {
        resolveOnce(false);
      });

      // Send graceful shutdown signal
      try {
        // Check one more time before killing
        if (child.exitCode !== null) {
          resolveOnce(false);
          return;
        }

        const killed = child.kill(signal);
        // If kill returned false, process already exited
        if (!killed) {
          resolveOnce(false);
        }
      } catch (_err) {
        // If kill throws, process is gone or unreachable
        resolveOnce(false);
      }
    });

    return closePromise;
  };

  return {
    config: resolvedConfig,
    process: child,
    close: stop,
  };
}
