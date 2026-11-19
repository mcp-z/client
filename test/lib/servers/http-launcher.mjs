// Launcher that runs long-lived-http.mjs as its live child and records the child's PID.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [pidFile, port] = process.argv.slice(2);
const server = spawn(process.execPath, [fileURLToPath(new URL('./long-lived-http.mjs', import.meta.url)), '--port', port ?? ''], { stdio: 'inherit' });
server.once('error', (error) => {
  process.stderr.write(`http-launcher: ${error.message}\n`);
  process.exit(1);
});
if (server.pid && pidFile) writeFileSync(pidFile, String(server.pid));
server.once('exit', (code) => process.exit(code ?? 1));
