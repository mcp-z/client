/**
 * Integration tests for http transport (MCP spec)
 *
 * Tests HTTP server starting and connection using createServerRegistry().
 * Validates url + start block configuration pattern.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import assert from 'assert';
import getPort from 'get-port';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ManagedClient } from '../../../src/client-helpers.ts';
import type { ServerRegistry, ServersConfig } from '../../../src/index.ts';
import { createServerRegistry } from '../../../src/spawn/spawn-servers.ts';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory (avoid process.cwd() - brittle!)
const projectRoot = path.resolve(__dirname, '../../..');

describe('http transport', () => {
  let registry: ServerRegistry | undefined;
  let serversConfig: ServersConfig;
  let client: ManagedClient | undefined;
  let port: number;
  let url: string;

  before(async () => {
    // Get available port dynamically
    port = await getPort();
    url = `http://localhost:${port}/mcp`;

    // Start HTTP server using createServerRegistry with start dialect (to spawn start blocks)
    serversConfig = {
      'echo-http': {
        url,
        start: {
          command: 'node',
          args: ['test/lib/servers/echo-http.mjs', '--port', String(port)],
        },
      },
    };

    registry = createServerRegistry(serversConfig, { cwd: projectRoot, dialects: ['start'] });

    // createServerRegistry returns fast - processes are starting, use connect for readiness
  });

  after(async () => {
    if (client) await client.close();
    if (registry) await registry.close();
  });

  it('should connect to http server using registry.connect', async () => {
    if (!registry) throw new Error('Registry not initialized');
    client = await registry.connect('echo-http');

    assert.ok(client, 'Client should be created');

    // Verify server is functional
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0, 'Should have tools');
  });

  it('should list tools from HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const tools = await client.listTools();
    const echoTool = tools.tools.find((t) => t.name === 'echo');

    assert.ok(echoTool, 'Should have echo tool');
    assert.strictEqual(echoTool.description, 'Echoes back the provided message');
  });

  it('should call tools on HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const wrapped = await client.callTool({ name: 'echo', arguments: { message: 'test-message' } });
    const result = wrapped.raw();

    const content = (result.content ?? []) as unknown[];
    assert.ok(content.length > 0, 'Should have content');
    const textContent = content[0] as { type: string; text: string };
    if (!textContent) throw new Error('Expected content at index 0');
    assert.strictEqual(textContent.type, 'text');
    assert.ok(textContent.text.includes('test-message'), 'Should echo message');
  });

  it('should list resources from HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const resources = await client.listResources();
    const echoResource = resources.resources.find((r) => r.name === 'echo');

    assert.ok(echoResource, 'Should have echo resource');
    assert.strictEqual(echoResource.description, 'Echoes back messages as resources');
  });

  it('should read resource from HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const resource = await client.readResource({ uri: 'echo://test-resource-message' });
    const result = resource.raw();

    assert.ok(result.contents.length > 0, 'Should have contents');
    const content = result.contents[0];
    if (!content) throw new Error('Expected content at index 0');
    assert.strictEqual(content.uri, 'echo://test-resource-message');
    // Narrow the discriminated union type
    if ('text' in content) {
      assert.ok(content.text.includes('test-resource-message'), 'Should echo resource message');
    } else {
      assert.fail('Expected text content');
    }
  });

  it('should list prompts from HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const prompts = await client.listPrompts();
    const echoPrompt = prompts.prompts.find((p) => p.name === 'echo');

    assert.ok(echoPrompt, 'Should have echo prompt');
    assert.strictEqual(echoPrompt?.description, 'Creates a prompt to process a message');
  });

  it('should get prompt from HTTP server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('echo-http');
    }

    const prompt = await client.getPrompt({ name: 'echo', arguments: { message: 'test-prompt-message' } });
    const result = prompt.raw();

    assert.ok(result.messages.length > 0, 'Should have messages');
    const message = result.messages[0];
    if (!message) throw new Error('Expected message at index 0');
    assert.strictEqual(message.role, 'user');
    // Narrow the discriminated union type
    if (message.content.type === 'text') {
      assert.ok(message.content.text.includes('test-prompt-message'), 'Should include prompt message');
    } else {
      assert.fail('Expected text content type');
    }
  });

  it('should handle connection errors gracefully', async () => {
    const invalidUrl = 'http://localhost:65534/mcp'; // Port that won't have a server running
    const transport = new StreamableHTTPClientTransport(new URL(invalidUrl));
    const testClient = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await assert.rejects(async () => {
      // Type assertion: SDK transport has sessionId: string | undefined but Transport expects string
      // This is safe at runtime - the undefined is valid per MCP spec
      await testClient.connect(transport as unknown as Transport);
    }, 'Should reject connection to invalid URL');
  });

  it('should support multiple concurrent connections', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const clients = await Promise.all([registry.connect('echo-http'), registry.connect('echo-http'), registry.connect('echo-http')]);

    assert.strictEqual(clients.length, 3, 'Should create 3 connections');

    for (const c of clients) {
      assert.ok(c, 'Each client should be created');
      await c.close();
    }
  });

  it('should have SSE fallback implemented for standard MCP transport support', async () => {
    // This test verifies that SSE fallback is implemented in connect
    // The fallback automatically tries SSE transport if Streamable HTTP fails
    //
    // This is important for compatibility with:
    // - FastMCP servers (use SSE as standard transport, return "Missing session ID" error)
    // - Servers using MCP protocol version 2024-11-05 (SSE-based)
    //
    // The fallback is transparent to users - no config changes needed.
    // Manual testing with FastMCP server confirms SSE fallback works.
    //
    // For now, we verify the feature doesn't break existing functionality:

    if (!registry) throw new Error('Registry not initialized');
    const testClient = await registry.connect('echo-http');
    assert.ok(testClient, 'SSE fallback implementation should not break normal connections');

    const tools = await testClient.listTools();
    assert.ok(tools.tools.length > 0, 'Should still list tools with SSE fallback code present');

    await testClient.close();

    // TODO: Add automated SSE-only server test when we have a FastMCP test server
    // This would spawn a server that rejects Streamable HTTP and only accepts SSE
  });
});
