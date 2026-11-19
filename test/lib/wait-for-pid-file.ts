import * as fs from 'fs';

interface LauncherClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Resolve the PID a fixture wrote, retrying while the file is absent or incomplete.
 * With `launcherClosed`, fails at once when the process that should write the file has closed without writing it.
 */
export async function waitForPidFile(pidFile: string, launcherClosed?: Promise<LauncherClose>): Promise<number> {
  let closed: LauncherClose | undefined;
  launcherClosed?.then((result) => {
    closed = result;
  });
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(pidFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (/^\d+$/.test(text)) return Number(text);
    if (closed) throw new Error(`The launcher closed (code=${closed.code}, signal=${closed.signal}) before writing ${pidFile}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
