#!/usr/bin/env node

/**
 * Bearer token authenticated MCP HTTP test server
 *
 * PURPOSE: Test manual bearer token authentication flows for HTTP MCP servers
 * FEATURES:
 * - Full MCP SDK (McpServer, StreamableHTTPServerTransport)
 * - Bearer token validation middleware with 401/403 error responses
 * - Configurable valid tokens via CLI --token arg or VALID_TOKENS env var
 * - Echo tool/resource/prompt (same as echo-http.mjs for test consistency)
 * - Token validation logging for debugging
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * AUTHENTICATION:
 * - Requires Authorization: Bearer <token> header in all requests
 * - Returns 401 Unauthorized if Authorization header missing or malformed
 * - Returns 403 Forbidden if bearer token is invalid
 * - Validates token against configured valid tokens list
 *
 * USAGE:
 *   node test/lib/servers/bearer-auth-http.mjs --port 3000 --token "test-token-123"
 *   VALID_TOKENS="token1,token2" node test/lib/servers/bearer-auth-http.mjs
 *
 * CONFIGURATION:
 *   --port <number>           Server port (default: 50300)
 *   --token <string>          Single valid bearer token (CLI arg)
 *   VALID_TOKENS=<csv>        Comma-separated valid tokens (env var)
 *   Default token: "test-bearer-token" (if no tokens configured)
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
        default: '50300',
      },
      token: {
        type: 'string',
      },
    },
    strict: true,
  });

  // Build valid tokens set from CLI arg or env var
  const validTokens = new Set();

  // Priority 1: CLI --token argument
  if (values.token) {
    validTokens.add(values.token);
  }

  // Priority 2: VALID_TOKENS environment variable (comma-separated)
  if (process.env.VALID_TOKENS) {
    const tokens = process.env.VALID_TOKENS.split(',').map((t) => t.trim());
    for (const token of tokens) {
      if (token) validTokens.add(token);
    }
  }

  // Default: Use test token if no tokens configured (for simple tests)
  if (validTokens.size === 0) {
    validTokens.add('test-bearer-token');
    console.error('[bearer-auth-http] No tokens configured, using default: test-bearer-token');
  }

  console.error(`[bearer-auth-http] Configured valid tokens: ${validTokens.size} token(s)`);

  return {
    port: Number.parseInt(values.port, 10),
    validTokens,
  };
}

/**
 * Bearer token validation middleware
 * Returns 401 if Authorization header missing or malformed
 * Returns 403 if bearer token is invalid
 * Passes through if token is valid
 */
function createBearerAuthMiddleware(validTokens) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    // Check for Authorization header
    if (!authHeader) {
      console.error('[bearer-auth-http] 401: Missing Authorization header');
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Missing Authorization header',
        },
        id: null,
      });
      return;
    }

    // Validate Bearer token format
    const match = /^Bearer (.+)$/i.exec(authHeader);
    if (!match || !match[1]) {
      console.error('[bearer-auth-http] 401: Invalid Authorization header format (expected: Bearer <token>)');
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Invalid Authorization header format (expected: Bearer <token>)',
        },
        id: null,
      });
      return;
    }

    const token = match[1];

    // Validate token against configured valid tokens
    if (!validTokens.has(token)) {
      console.error('[bearer-auth-http] 403: Invalid bearer token (token does not match configured valid tokens)');
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Invalid bearer token',
        },
        id: null,
      });
      return;
    }

    console.error('[bearer-auth-http] Token validated successfully');
    next();
  };
}

async function main() {
  const config = parseConfig();

  const server = new McpServer({
    name: 'bearer-auth-http',
    version: '1.0.0',
  });

  // Register echo tool (same as echo-http.mjs for test consistency)
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

  // Register echo resource (same as echo-http.mjs)
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

  // Register echo prompt (same as echo-http.mjs)
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

  // Create Express app with bearer token authentication
  const app = express();

  app.use(express.json());

  // Apply bearer token validation middleware to /mcp endpoint
  const bearerAuthMiddleware = createBearerAuthMiddleware(config.validTokens);

  // Handle GET requests to /mcp with 405 (tells client no SSE support)
  app.get('/mcp', (_req, res) => {
    res.status(405).end();
  });

  // POST /mcp with bearer token authentication
  app.post('/mcp', bearerAuthMiddleware, async (req, res) => {
    console.error('[bearer-auth-http] POST /mcp - authenticated request');
    try {
      // Create NEW transport for each request (stateless/sessionless mode per MCP SDK docs)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      console.error('[bearer-auth-http] Request handled successfully');
    } catch (error) {
      console.error('[bearer-auth-http] Error handling MCP request:', error);
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
    console.error(`[bearer-auth-http] Ready on port ${config.port}`);
  });

  // Handle startup failures (port already in use, etc.)
  httpServer.on('error', (error) => {
    console.error(`[bearer-auth-http] FATAL: Failed to start server on port ${config.port}:`, error.message);
    if (error.code === 'EADDRINUSE') {
      console.error(`[bearer-auth-http] FATAL: Port ${config.port} is already in use`);
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
  console.error('[bearer-auth-http] FATAL: Uncaught error during startup:', error);
  process.exit(1);
});
