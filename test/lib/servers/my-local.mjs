#!/usr/bin/env node
/**
 * Minimal test server for cwd-resolution integration tests
 *
 * PURPOSE: Validate that relative paths in .mcp.json configs resolve correctly
 * FEATURES: Minimal JSON-RPC MCP implementation for testing
 */

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdout.write('');

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) {
      idx = buffer.indexOf('\n');
      continue;
    }
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'my-local',
              version: '1.0.0',
            },
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'tools/list') {
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            tools: [
              {
                name: 'test',
                description: 'Test tool',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.id !== undefined) {
        const response = { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (_e) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      };
      process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
    }
    idx = buffer.indexOf('\n');
  }
});
