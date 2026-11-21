#!/usr/bin/env node
/**
 * Stdio MCP server that reports the clientInfo of the `initialize` request it received.
 *
 * PURPOSE: let a spec see the name and version a client sends to a stdio server.
 * FEATURES: one tool, `client-info`, returning the client's name and version as the server recorded them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'client-info-stdio', version: '1.0.0' });
server.registerTool('client-info', { description: 'Returns the clientInfo of the initialize request', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(server.server.getClientVersion() ?? null) }],
}));
await server.connect(new StdioServerTransport());
