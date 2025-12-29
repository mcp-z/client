#!/usr/bin/env node
/**
 * Partial MCP implementation - only implements tools/list
 *
 * PURPOSE: Test that inspect command handles partial MCP implementations gracefully
 * FEATURES:
 * - Implements initialize and tools/list (MCP core)
 * - Returns JSON-RPC error -32601 (Method not found) for resources/list and prompts/list
 * - Mimics behavior of third-party servers like Todoist that don't implement all capabilities
 *
 * USAGE: Used by inspect.test.ts to verify partial implementation handling
 * NOTE: This is intentionally incomplete - it simulates real-world partial implementations
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
        // Handle MCP initialization - declare only tools capability
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} }, // Only declare tools, not resources/prompts
            serverInfo: {
              name: 'partial-test-server',
              version: '1.0.0',
            },
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'tools/list') {
        // Implement tools/list - this server HAS tools
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            tools: [
              {
                name: 'partial-tool',
                description: 'Test tool from partial implementation',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
        // Return JSON-RPC "Method not found" error for unimplemented methods
        // This mimics third-party servers like Todoist that don't implement these
        const response = {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.id !== undefined) {
        // Unknown method
        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        };
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
