import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string' } }, strict: true });
const port = Number(values.port);
let shuttingDown = false;

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/__mcpz/shutdown') {
    if (shuttingDown) {
      response.writeHead(202).end('already stopping');
      return;
    }
    shuttingDown = true;
    response.writeHead(202).end('stopping', () => {
      server.close((error) => {
        if (error) {
          console.error(`Server close failed: ${error.message}`);
          process.exitCode = 1;
        }
      });
    });
    return;
  }

  response.writeHead(200).end('ok');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`READY:${process.pid}\n`);
});

const shutdown = () => {
  server.close((error) => {
    if (error) {
      console.error(`Server close failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
