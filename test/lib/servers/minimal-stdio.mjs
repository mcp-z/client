#!/usr/bin/env node
/**
 * Minimal hand-rolled JSON-RPC stdio server stub
 *
 * PURPOSE: Test low-level stdio connection logic without MCP SDK overhead
 * FEATURES:
 * - Hand-rolled JSON-RPC implementation (no MCP SDK dependency)
 * - Minimal MCP protocol support (initialize, tools/list, tools/call)
 * - Resources/list, resources/read, prompts/list, prompts/get endpoints
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Useful for testing connection, env vars, shutdown logic
 *
 * USAGE: Used by connectStdioServer tests for low-level validation
 * NOTE: This is NOT a full MCP implementation - it's a minimal JSON-RPC stub
 */

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdout.write(''); // ensure pipe is open

// Handle graceful shutdown
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  // naive line split; real MCP uses JSON-RPC with stream framing.
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
      // Respond minimally to show the bridge works.
      if (msg.method === 'initialize') {
        // Handle MCP initialization handshake
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'test-server',
              version: '1.0.0',
            },
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'tools/list') {
        // Handle MCP tools/list request
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            tools: [
              {
                name: 'ping',
                description: 'Test ping tool',
                inputSchema: { type: 'object', properties: {} },
              },
              {
                name: 'echo',
                description: 'Echo a message with optional count',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      description: 'The message to echo',
                    },
                    count: {
                      type: 'integer',
                      description: 'Number of times to repeat',
                      default: 1,
                      minimum: 1,
                      maximum: 10,
                    },
                    uppercase: {
                      type: 'boolean',
                      description: 'Convert to uppercase',
                    },
                  },
                  required: ['message'],
                },
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'resources/list') {
        // Handle MCP resources/list request
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            resources: [
              {
                uri: 'test://hello',
                name: 'hello',
                description: 'A test resource',
                mimeType: 'text/plain',
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'resources/read') {
        // Handle MCP resources/read request
        const params = msg.params ?? {};
        const uri = params?.uri || 'unknown';
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            contents: [
              {
                uri,
                text: `Resource content for: ${uri}`,
                mimeType: 'text/plain',
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'prompts/list') {
        // Handle MCP prompts/list request
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            prompts: [
              {
                name: 'greet',
                description: 'A greeting prompt',
                arguments: [
                  {
                    name: 'name',
                    description: 'Name to greet',
                    required: true,
                  },
                ],
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'prompts/get') {
        // Handle MCP prompts/get request
        const params = msg.params ?? {};
        const promptName = params?.name || 'unknown';
        const args = params?.arguments || {};
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            description: `Prompt: ${promptName}`,
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Hello, ${args.name || 'World'}!`,
                },
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'tools/call') {
        // Handle MCP tools/call request
        // Real MCP tools return: { type: 'text', text: JSON }
        const params = msg.params ?? {};
        const toolName = params?.name || 'unknown';
        const resultData = toolName === 'ping' ? { result: 'pong' } : { result: { ok: true } };
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(resultData),
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'ping') {
        const response = { jsonrpc: '2.0', id: msg.id ?? null, result: 'pong' };
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
