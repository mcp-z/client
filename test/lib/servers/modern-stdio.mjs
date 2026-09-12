#!/usr/bin/env node
// Real MCP SDK v2 stdio fixture for negotiation and tool round-trip coverage.

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'modern-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.registerTool(
    'echo',
    {
      description: 'Echoes back the provided message',
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Tool echo: ${message}` }],
    })
  );
  return server;
});
