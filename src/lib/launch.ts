import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { win32 } from 'path';

export interface Launch {
  file: string;
  args: string[];
  env?: Record<string, string>;
  waitForExit: boolean;
}

// Windows Subsystem for Linux reports platform 'linux' but needs the Windows browser.
// A /proc/version that cannot be read for any reason but its absence is an error, not "not WSL".
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().indexOf('microsoft') >= 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// MCP_Z_OPEN_URL is a private channel to the one PowerShell child, not configuration this package reads.
const URL_VARIABLE = 'MCP_Z_OPEN_URL';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath $env:${URL_VARIABLE}`];

// CreateProcess searches the current directory before PATH for a bare name, so Windows runs the copy under SystemRoot.
function windowsPowershell(env: NodeJS.ProcessEnv): string {
  if (!env.SystemRoot) throw new Error('openUrl: SystemRoot is not set');
  return win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// The URL is one whole argv element or one environment value, never inside text a shell or interpreter parses.
export function launchCommand(url: string, platform: NodeJS.Platform, wsl: boolean, env: NodeJS.ProcessEnv = process.env): Launch {
  if (platform === 'win32') return { file: windowsPowershell(env), args: POWERSHELL_ARGS, env: { [URL_VARIABLE]: url }, waitForExit: true };
  if (platform === 'darwin') return { file: 'open', args: [url], waitForExit: true };
  // PowerShell reaches the Windows browser from inside WSL, where xdg-open cannot; WSLENV carries the variable across.
  if (wsl) {
    const inherited = env.WSLENV;
    return { file: 'powershell.exe', args: POWERSHELL_ARGS, env: { [URL_VARIABLE]: url, WSLENV: inherited ? `${inherited}:${URL_VARIABLE}` : URL_VARIABLE }, waitForExit: true };
  }
  return { file: 'xdg-open', args: [url], waitForExit: false };
}

export function launch(url: string, platform: NodeJS.Platform = process.platform, wsl?: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let command: Launch;
    try {
      command = launchCommand(url, platform, wsl === undefined ? isWsl() : wsl);
    } catch (err) {
      return reject(err);
    }
    const { file, args, env, waitForExit } = command;
    if (platform === 'win32' && !existsSync(file)) return reject(new Error(`openUrl: ${file} not found`));
    // xdg-open can keep running until the browser exits, so on that path only the start is awaited.
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, detached: !waitForExit, env: { ...process.env, ...env } });
    child.on('error', (err) => reject(startError(err as NodeJS.ErrnoException, file, args.indexOf(url) < 0)));
    if (!waitForExit) {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      return;
    }
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`openUrl: ${file} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

// Node's spawn error carries `spawnargs`, which holds the URL where the URL is an argument, so it is rebuilt without it.
// The original is kept as `cause` only where the URL travels in the environment instead.
function startError(err: NodeJS.ErrnoException, file: string, urlNotInArgs: boolean): Error {
  const error: NodeJS.ErrnoException = new Error(`openUrl: could not start ${file}: ${err.code || err.message}`);
  error.code = err.code;
  error.syscall = err.syscall;
  error.errno = err.errno;
  error.path = file;
  if (urlNotInArgs) Object.defineProperty(error, 'cause', { value: err, writable: true, configurable: true });
  return error;
}
