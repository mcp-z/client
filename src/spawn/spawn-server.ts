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
   * Close the server gracefully, terminating its process tree on Windows.
   * Sends the specified signal (default: SIGINT), then force-kills after timeout.
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

function terminateWindowsProcessTree(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');

  return new Promise((resolve, reject) => {
    const taskkill = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
    taskkill.once('error', reject);
    taskkill.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`taskkill.exe failed to stop process tree rooted at PID ${pid} (exit code ${code ?? 'unknown'})`));
    });
  });
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
    const closePromise = new Promise<{ timedOut: boolean; killed: boolean }>((resolve, reject) => {
      let isResolved = false;
      let wasKilled = false;
      let timedOut = false;

      const resolveOnce = (didTimeout: boolean) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeout);
        resolve({ timedOut: didTimeout, killed: wasKilled });
      };

      const rejectOnce = (error: Error) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeout);
        reject(error);
      };

      // Set timeout for forceful kill
      const timeout = setTimeout(() => {
        timedOut = true;
        const forceKill = async () => {
          try {
            if (process.platform === 'win32' && child.pid) {
              await terminateWindowsProcessTree(child.pid, true);
              wasKilled = true;
            } else if (child.exitCode === null && !child.killed) {
              wasKilled = child.kill('SIGKILL');
            }
            resolveOnce(true);
          } catch (error) {
            rejectOnce(error instanceof Error ? error : new Error(String(error)));
          }
        };
        void forceKill();
      }, timeoutMs);

      // Listen for 'close' event (not 'exit') to wait for stdio close
      child.once('close', () => {
        if (!timedOut) resolveOnce(false);
      });

      // Also listen for 'error' event in case spawn failed
      // This prevents promise from hanging forever if process never started
      child.once('error', () => {
        resolveOnce(false);
      });

      const requestShutdown = async () => {
        try {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveOnce(false);
            return;
          }

          if (process.platform === 'win32' && child.pid) {
            await terminateWindowsProcessTree(child.pid, false);
          } else if (!child.kill(signal)) {
            resolveOnce(false);
          }
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        }
      };
      void requestShutdown();
    });

    return closePromise;
  };

  return {
    config: resolvedConfig,
    process: child,
    close: stop,
  };
}
