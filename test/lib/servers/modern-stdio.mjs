#!/usr/bin/env node
/**
 * Full hand-rolled 2026-07-28-era stdio test server
 *
 * PURPOSE: Test fixture for protocol version negotiation against the 2026-07-28 revision
 * FEATURES:
 * - No MCP SDK dependency (hand-rolled JSON-RPC)
 * - Answers the connect-time `server/discover` probe with the modern revision
 * - Serves the modern-era `initialize` handshake (echoes the requested revision)
 * - Echo tool with JSON-structured responses (tools/list, tools/call)
 * - Stamps `resultType: "complete"` on every result, as the 2026-07-28 wire revision requires
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * USAGE: node test/lib/servers/modern-stdio.mjs
 */

import * as readline from 'readline';

const MODERN_REVISION = '2026-07-28';
const SERVER_INFO = { name: 'modern-stdio', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

// Every 2026-07-28 wire result carries `resultType: "complete"` (the absent-means-complete
// bridge applies only to earlier-revision servers).
function completeResult(result) {
  return { resultType: 'complete', ...result };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const handler = (message) => {
  // Notifications (no id): initialized and friends - nothing to answer
  if (message.id === undefined) return;

  switch (message.method) {
    // The negotiation probe: modern evidence for 'auto' / pinned clients
    case 'server/discover':
      respond(
        message.id,
        completeResult({
          supportedVersions: [MODERN_REVISION],
          capabilities: CAPABILITIES,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        })
      );
      break;
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      // Serve the revision the client asked for when it is modern; otherwise the modern one
      const protocolVersion = typeof requested === 'string' && requested >= MODERN_REVISION ? requested : MODERN_REVISION;
      respond(
        message.id,
        completeResult({
          protocolVersion,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        })
      );
      break;
    }
    case 'tools/list':
      respond(
        message.id,
        completeResult({
          tools: [
            {
              name: 'echo',
              description: 'Echoes back the provided message',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
            },
          ],
        })
      );
      break;
    case 'tools/call':
      respond(
        message.id,
        completeResult({
          content: [{ type: 'text', text: JSON.stringify({ echo: `Tool echo: ${message.params?.arguments?.message ?? ''}` }) }],
        })
      );
      break;
    default:
      respondError(message.id, -32601, 'Method not found');
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handler(JSON.parse(line));
  } catch {
    // Malformed line - a real server would answer with a parse error; a fixture that
    // goes silent keeps negotiation tests from coupling to JSON-RPC error shapes.
  }
});

// Graceful shutdown on SIGINT/SIGTERM
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.exit(0);
  });
}
