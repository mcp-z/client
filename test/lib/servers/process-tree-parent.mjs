import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, pidFile] = process.argv.slice(2);

if (mode === 'descendant') {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  if (!pidFile) throw new Error('Missing descendant readiness file');
  writeFileSync(pidFile, String(process.pid));
  process.send?.('ready');
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', pidFile ?? ''], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: false,
  });
  if (!child.pid || !pidFile) throw new Error('Could not create the owned descendant');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Descendant did not report readiness')), 5000);
    child.once('message', (message) => {
      if (message === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  }).catch((error) => {
    child.kill();
    throw error;
  });
  child.disconnect();
  child.unref();
}
