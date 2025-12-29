#!/usr/bin/env node

/**
 * Full MCP SDK http test server
 *
 * PURPOSE: Demonstrates complete MCP server with HTTP transport
 * FEATURES:
 * - Full MCP SDK (McpServer, StreamableHTTPServerTransport)
 * - Echo tool with JSON-structured responses
 * - Echo resource for URI-based access
 * - Echo prompt for message processing
 * - Configurable port via --port argument
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * USAGE: node test/lib/servers/echo-http.mjs --port 3000
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { parseArgs } from 'util';
import { z } from 'zod';

function parseConfig() {
  const { values } = parseArgs({
    options: {
      port: {
        type: 'string',
        default: '50200',
      },
    },
    strict: true,
  });

  return {
    port: Number.parseInt(values.port, 10),
  };
}

async function main() {
  const config = parseConfig();

  const server = new McpServer({
    name: 'echo-http',
    version: '1.0.0',
  });

  // Register echo tool with JSON-structured response
  server.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Echoes back the provided message',
      inputSchema: { message: z.string() },
      outputSchema: { echo: z.string() },
    },
    async ({ message }) => {
      const output = { echo: `Tool echo: ${message}` };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  );

  // Register echo resource (with list descriptor so it shows in listResources())
  server.registerResource(
    'echo',
    new ResourceTemplate('echo://{message}', {
      list: async () => ({
        resources: [{ uri: 'echo://{message}', name: 'echo', description: 'Echoes back messages as resources', mimeType: 'text/plain' }],
      }),
    }),
    {
      title: 'Echo Resource',
      description: 'Echoes back messages as resources',
    },
    async (uri, { message }) => ({
      contents: [
        {
          uri: uri.href,
          text: `Resource echo: ${message}`,
        },
      ],
    })
  );

  // Register echo prompt
  server.registerPrompt(
    'echo',
    {
      title: 'Echo Prompt',
      description: 'Creates a prompt to process a message',
      argsSchema: { message: z.string() },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please process this message: ${args.message}`,
          },
        },
      ],
    })
  );

  // Create Express app with sessionless MCP transport
  const app = express();

  app.use(express.json());

  // Handle GET requests to /mcp with 405 (tells client no SSE support)
  app.get('/mcp', (_req, res) => {
    res.status(405).end();
  });

  app.post('/mcp', async (req, res) => {
    console.error('[echo-http] POST /mcp - body:', JSON.stringify(req.body, null, 2));
    try {
      // Create NEW transport for each request (stateless/sessionless mode per MCP SDK docs)
      // This prevents request ID collisions when multiple clients use the same endpoint
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      console.error('[echo-http] Created transport with sessionIdGenerator: undefined');

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      console.error('[echo-http] Server connected to transport');
      await transport.handleRequest(req, res, req.body);
      console.error('[echo-http] Request handled successfully');
    } catch (error) {
      console.error('[echo-http] Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(config.port, () => {
    console.error(`[echo-http] Ready on port ${config.port}`);
  });

  // Handle startup failures (port already in use, etc.)
  httpServer.on('error', (error) => {
    console.error(`[echo-http] FATAL: Failed to start server on port ${config.port}:`, error.message);
    if (error.code === 'EADDRINUSE') {
      console.error(`[echo-http] FATAL: Port ${config.port} is already in use`);
    }
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[echo-http] FATAL: Uncaught error during startup:', error);
  process.exit(1);
});
