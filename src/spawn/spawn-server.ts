/**
 * Low-level single server spawning utilities.
 * Provides core process spawning with path resolution, environment management, and lifecycle control.
 */

import type { ChildProcess, StdioOptions } from 'child_process';
import crossSpawn from 'cross-spawn';
import * as path from 'path';
import * as process from 'process';
import type { StopCommandConfig } from '../types.ts';
import { logger } from '../utils/logger.ts';
import { resolveArgsPaths } from '../utils/path-utils.ts';
import { OwnedProcessTree } from './owned-process-tree.ts';

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
const PROCESS_TERMINATION_TIMEOUT_MS = 5000;
const PROCESS_POLL_INTERVAL_MS = 25;

interface ProcessCloseEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessCompletion {
  closed: boolean;
  processGroupEmpty?: boolean;
  error?: Error;
}

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
  /** Whether to add process.env to env; registry callers provide a pre-merged environment */
  inheritEnv?: boolean;
  /** Standard I/O configuration */
  stdio?: StdioOptions;
  /** Application-specific shutdown command for an owned HTTP server */
  stop?: StopCommandConfig;
}

/**
 * Handle to a spawned server process.
 * Provides access to the process, resolved config, and lifecycle control.
 * @hidden
 */
export interface ServerProcess {
  config: {
    name: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdio: StdioOptions;
    shell: false;
  };
  process: ChildProcess;
  close: (signal?: NodeJS.Signals, opts?: { timeoutMs?: number }) => Promise<{ timedOut: boolean; killed: boolean }>;
}

function normalizeEnv(env?: Record<string, string>, inheritEnv = true): Record<string, string> {
  const merged = { ...(inheritEnv ? process.env : {}), ...(env || {}) };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCompletion(closeEvent: Promise<ProcessCloseEvent>, childClosed: () => boolean, tree: OwnedProcessTree | undefined, timeoutMs: number): Promise<ProcessCompletion> {
  if (!tree) return { closed: (await waitForChildClose(closeEvent, timeoutMs)) !== undefined };

  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (true) {
    let processGroupEmpty = false;
    try {
      processGroupEmpty = tree.isEmpty();
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    const closed = childClosed();
    if (closed && processGroupEmpty) return { closed, processGroupEmpty };
    if (Date.now() >= deadline) return { closed, processGroupEmpty, ...(lastError && { error: lastError }) };
    await delay(Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

function isCompletionSuccessful(completion: ProcessCompletion): boolean {
  return completion.closed && completion.processGroupEmpty !== false;
}

function terminateChild(child: ChildProcess, tree: OwnedProcessTree | undefined): { killed: boolean; error?: Error } {
  if (tree) return tree.terminate();
  try {
    return { killed: child.kill('SIGKILL') };
  } catch (error) {
    return { killed: false, error: asError(error) };
  }
}

function waitForChildClose(closeEvent: Promise<ProcessCloseEvent>, timeoutMs: number): Promise<ProcessCloseEvent | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    closeEvent,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function requestProcessSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) throw new Error('Cannot request cooperative shutdown because the server has no process ID');
  if (process.platform === 'win32') throw new Error('POSIX process signals are not available on Windows');
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withCause(message: string, cause: Error): Error {
  return new Error(message, { cause });
}

async function runStopCommand(command: StopCommandConfig, cwd: string, timeoutMs: number, inheritEnv: boolean): Promise<void> {
  const stopCwd = command.cwd ? path.resolve(cwd, command.cwd) : cwd;
  const env = normalizeEnv(command.env, inheritEnv);
  const args = command.args ? resolveArgsPaths(command.args, stopCwd) : [];
  const child = crossSpawn(command.command, args, {
    cwd: stopCwd,
    env,
    stdio: 'ignore',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  let closed = false;
  let closeEventValue: ProcessCloseEvent | undefined;
  const closeEvent = new Promise<ProcessCloseEvent>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      closeEventValue = { code, signal };
      resolve({ code, signal });
    });
  });

  if (!child.pid) {
    const result = await waitForChildClose(closeEvent, timeoutMs);
    if (!result) throw new Error(`Stop command did not start or close within ${timeoutMs}ms`);
    if (spawnError) throw withCause(`Stop command could not be started: ${spawnError.message}`, spawnError);
  }

  const tree = child.pid && process.platform !== 'win32' ? new OwnedProcessTree(child.pid) : undefined;
  const completion = await waitForCompletion(closeEvent, () => closed, tree, timeoutMs);
  if (!isCompletionSuccessful(completion)) {
    const termination = terminateChild(child, tree);
    const afterTermination = await waitForCompletion(closeEvent, () => closed, tree, PROCESS_TERMINATION_TIMEOUT_MS);
    const details = [completion.error?.message, termination.error?.message].filter(Boolean).join('; ');
    const reason = `Stop command exceeded ${timeoutMs}ms and required emergency process termination`;
    const remaining = !isCompletionSuccessful(afterTermination) ? '; stop command or its POSIX process group remained alive' : '';
    throw new Error(`${reason}${details ? `: ${details}` : ''}${remaining}`);
  }

  if (spawnError) throw withCause(`Stop command could not be started: ${spawnError.message}`, spawnError);
  if (closeEventValue && (closeEventValue.code !== 0 || closeEventValue.signal !== null)) {
    throw new Error(`Stop command exited with code ${closeEventValue.code ?? 'unknown'}${closeEventValue.signal ? ` (signal ${closeEventValue.signal})` : ''}`);
  }
}

/**
 * Spawn a single server process with path resolution and environment management.
 *
 * @internal
 * @param opts - Server spawn options
 * @returns ServerProcess handle with resolved config and lifecycle control
 */
export function spawnProcess(opts: SpawnProcessOptions): ServerProcess {
  const name = opts.name;
  const command = opts.command;
  const cwd = opts.cwd ?? process.cwd();
  const stdio = opts.stdio ?? 'inherit';
  const args = opts.args ? resolveArgsPaths(opts.args, cwd) : [];
  const inheritEnv = opts.inheritEnv ?? true;
  const env = normalizeEnv(opts.env, inheritEnv);
  const resolvedConfig = { name, command, args, cwd, env, stdio, shell: false as const };

  logger.info(`[${name}] → ${command} ${args.join(' ')}`);
  const child = crossSpawn(command, args, {
    cwd,
    env,
    stdio,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  if (child.stderr) child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let isClosed = false;
  let _closeEventValue: ProcessCloseEvent | undefined;
  const closeEvent = new Promise<ProcessCloseEvent>((resolve) => {
    child.once('close', (code, signal) => {
      isClosed = true;
      _closeEventValue = { code, signal };
      logger.info(`[${name}] closed (code=${code}, signal=${signal || 'none'})`);
      resolve({ code, signal });
    });
    child.once('error', (error) => logger.info(`[${name}] process error: ${error.message}`));
  });
  const tree = child.pid && process.platform !== 'win32' ? new OwnedProcessTree(child.pid) : undefined;
  let closePromise: Promise<{ timedOut: boolean; killed: boolean }> | undefined;

  const performClose = async (signal: NodeJS.Signals, timeoutMs: number): Promise<{ timedOut: boolean; killed: boolean }> => {
    if (!child.pid) {
      await waitForChildClose(closeEvent, timeoutMs);
      throw new Error(`Cannot verify shutdown of server '${name}' because it has no process ID`);
    }

    let timedOut = false;
    let killed = false;
    const errors: Error[] = [];
    let stopSucceeded = false;

    if (opts.stop) {
      try {
        await runStopCommand(opts.stop, cwd, timeoutMs, inheritEnv);
        stopSucceeded = true;
      } catch (error) {
        errors.push(withCause(`Server '${name}' application stop command failed: ${asError(error).message}`, asError(error)));
      }
    } else if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    } else if (process.platform !== 'win32') {
      try {
        requestProcessSignal(child, signal);
      } catch (error) {
        errors.push(withCause(`Server '${name}' cooperative signal failed: ${asError(error).message}`, asError(error)));
      }
    }

    let completion = await waitForCompletion(closeEvent, () => isClosed, tree, timeoutMs);
    if (completion.error) errors.push(withCause(`Could not inspect the owned process tree for server '${name}'`, completion.error));

    if (!isCompletionSuccessful(completion)) {
      timedOut = true;
      if (!opts.stop && child.stdin && process.platform !== 'win32') {
        try {
          requestProcessSignal(child, signal);
        } catch (error) {
          errors.push(withCause(`Server '${name}' cooperative signal failed: ${asError(error).message}`, asError(error)));
        }
        completion = await waitForCompletion(closeEvent, () => isClosed, tree, timeoutMs);
        if (completion.error) errors.push(withCause(`Could not inspect the owned process tree for server '${name}'`, completion.error));
      } else if (!opts.stop && process.platform !== 'win32' && !child.stdin) {
        // The first signal was sent before waiting for an inherited-stdio HTTP process.
      }
    }

    if (!isCompletionSuccessful(completion)) {
      const termination = terminateChild(child, tree);
      killed ||= termination.killed;
      if (termination.error) errors.push(withCause(`Emergency termination failed for server '${name}'`, termination.error));
      completion = await waitForCompletion(closeEvent, () => isClosed, tree, PROCESS_TERMINATION_TIMEOUT_MS);
      if (!isCompletionSuccessful(completion)) {
        errors.push(new Error(`Server '${name}' did not close${completion.processGroupEmpty === false ? ' with its POSIX process group' : ''} after emergency termination`));
      }
    }

    if (opts.stop && !stopSucceeded && errors.length === 0) {
      errors.push(new Error(`Server '${name}' application stop command did not complete successfully`));
    }
    if (errors.length > 0) throw new AggregateError(errors, `Server '${name}' shutdown completed with ${errors.length} failure(s)`);
    return { timedOut, killed };
  };

  const close = (signal: NodeJS.Signals = 'SIGINT', closeOptions: { timeoutMs?: number } = {}): Promise<{ timedOut: boolean; killed: boolean }> => {
    closePromise ??= performClose(signal, closeOptions.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    return closePromise;
  };

  return { config: resolvedConfig, process: child, close };
}
