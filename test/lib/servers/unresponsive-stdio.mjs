import { writeFileSync } from 'node:fs';

process.stdin.resume();
process.on('SIGINT', () => {});
setInterval(() => {}, 1000);
const [pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
process.stderr.write('READY\n');
