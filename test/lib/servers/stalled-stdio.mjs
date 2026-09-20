process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
