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
 * USAGE: node test/lib/servers/echo-stdio.mjs
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  let invocations = 0;
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
      inputSchema: { message: z.string(), mode: z.enum(['rich', 'error']).optional() },
      outputSchema: { echo: z.string() },
    },
    async ({ message, mode }) => {
      invocations += 1;
      const output = { echo: `Tool echo: ${message}` };
      if (mode === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Cannot echo: ${message}` }],
          error: { message: `Echo rejected: ${message}`, code: 'ECHO_REJECTED' },
          _meta: { invocations },
        };
      }
      if (mode === 'rich') {
        return {
          content: [
            { type: 'text', text: JSON.stringify(output) },
            { type: 'image', data: 'AAEC', mimeType: 'image/png' },
            { type: 'audio', data: 'AwQF', mimeType: 'audio/wav' },
          ],
          structuredContent: output,
          _meta: { invocations, json: 'metadata extension' },
          json: 'server json extension',
          text: 'server text extension',
        };
      }
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
      ...(message === 'rich' ? { _meta: { fixture: 'echo-resource' }, json: 'resource extension' } : {}),
      contents:
        message === 'rich'
          ? [
              { uri: uri.href, blob: 'AAEC', mimeType: 'application/octet-stream' },
              { uri: 'echo://second', text: '{"second":true}', mimeType: 'application/json' },
            ]
          : [
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
      ...(args.message === 'rich' ? { description: 'Rich echo prompt', _meta: { fixture: 'echo-prompt' }, text: 'prompt extension' } : {}),
      messages:
        args.message === 'rich'
          ? [
              { role: 'user', content: { type: 'text', text: 'First message' } },
              { role: 'assistant', content: { type: 'image', data: 'AAEC', mimeType: 'image/png' } },
              { role: 'assistant', content: { type: 'text', text: 'Second message' } },
            ]
          : [
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
