import { createServer } from 'node:http';

const server = createServer((_request, response) => {
  response.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY:${process.pid}\n`);
});
