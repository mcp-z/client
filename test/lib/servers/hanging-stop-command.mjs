import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [pidFile] = process.argv.slice(2);
const descendant = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: 'ignore',
  detached: false,
});

if (!descendant.pid || !pidFile) throw new Error('Could not create the stop-command descendant');
writeFileSync(pidFile, String(descendant.pid));
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
