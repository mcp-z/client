process.stdin.resume();
process.on('SIGINT', () => {});
setInterval(() => {}, 1000);
process.stderr.write('READY\n');
