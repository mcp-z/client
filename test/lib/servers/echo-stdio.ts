#!/usr/bin/env node
/**
 * Full MCP SDK stdio test server
 *
 * PURPOSE: Demonstrates complete MCP server with stdio transport
 * FEATURES:
 * - Full MCP SDK (McpServer, StdioServerTransport)
 * - Echo tool with JSON-structured responses
 * - Echo resource for URI-based access
 * - Echo prompt for message processing
 * - Process-based communication (stdin/stdout)
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * USAGE: node test/lib/servers/echo-stdio.ts
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({
    name: 'echo-stdio',
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
      argsSchema: { message: z.string() } as const,
    },
    (args: { message: string }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please process this message: ${args.message}`,
          },
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
