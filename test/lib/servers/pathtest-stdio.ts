#!/usr/bin/env node
/**
 * MCP SDK stdio server for relative path resolution testing
 *
 * PURPOSE: Test that spawn-cluster correctly resolves relative paths with cwd
 * FEATURES:
 * - Full MCP SDK (McpServer, StdioServerTransport)
 * - Standard echo tool/resource/prompt for verification
 * - Used to validate path resolution in spawn-cluster
 *
 * USAGE: spawn-cluster with cwd parameter and relative path in args
 * VALIDATES: Relative path resolution works correctly
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({
    name: 'my-local',
    version: '1.0.0',
  });

  server.registerResource(
    'echo',
    new ResourceTemplate('echo://{message}', { list: undefined }),
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
