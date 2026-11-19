// Launcher that keeps the server as its live child with inherited stdio, the shape cmd /c produces.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [pidFile] = process.argv.slice(2);
const server = spawn(process.execPath, [fileURLToPath(new URL('./unresponsive-stdio.mjs', import.meta.url)), pidFile ?? ''], { stdio: 'inherit' });
server.once('error', (error) => {
  process.stderr.write(`stdio-launcher: ${error.message}\n`);
  process.exit(1);
});
server.once('exit', (code) => process.exit(code ?? 1));
