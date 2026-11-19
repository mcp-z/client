import type { ChildProcess } from 'child_process';
import * as process from 'process';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Process ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function forceStopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export function waitForChildClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}
