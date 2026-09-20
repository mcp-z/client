import * as process from 'process';

interface TerminationResult {
  killed: boolean;
  error?: Error;
}

/** Tracks the detached process group used for owned processes on POSIX. */
export class OwnedProcessTree {
  private readonly _rootPid: number;

  constructor(rootPid: number) {
    if (process.platform === 'win32') throw new Error('Owned process groups are not available on Windows');
    this._rootPid = rootPid;
  }

  isEmpty(): boolean {
    try {
      process.kill(-this._rootPid, 0);
      return false;
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return true;
      if (isErrno(error, 'EPERM')) return false;
      throw toError(error);
    }
  }

  terminate(): TerminationResult {
    try {
      process.kill(-this._rootPid, 'SIGKILL');
      return { killed: true };
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return { killed: false };
      return { killed: false, error: toError(error) };
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
