/**
 * Tests for registry.connect() - transport inference and MCP client connection
 *
 * Validates intelligent transport inference from server configuration.
 * Tests stdio transport (the only transport type that can be spawned locally).
 */

import assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ManagedClient } from '../../../src/client-helpers.ts';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import type { ServerRegistry, ServersConfig } from '../../../src/index.ts';
import { createServerRegistry } from '../../../src/spawn/spawn-servers.ts';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory (avoid process.cwd() - brittle!)
const projectRoot = path.resolve(__dirname, '../../..');

describe('registry.connect', () => {
  let registry: ServerRegistry | undefined;
  const clients: ManagedClient[] = [];
  let serversConfig: ServersConfig;

  before(async () => {
    // Start test servers with stdio transport
    serversConfig = {
      'test-stdio-1': {
        command: 'node',
        args: ['test/lib/servers/echo-stdio.mjs'],
      },
      'test-stdio-2': {
        command: 'node',
        args: ['test/lib/servers/echo-stdio.mjs'],
      },
    };

    registry = createServerRegistry(serversConfig, { cwd: projectRoot });

    // No delay needed - servers are ready immediately after starting.
    // The tests validate readiness by calling listTools() which would fail if not ready.
  });

  after(async () => {
    for (const client of clients) {
      if (client) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (registry) await registry.close();
  });

  it('should connect to first stdio server (default transport)', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

    assert.ok(client, 'Client should be created');

    // Verify client is functional - client.connect() already validates readiness
    const result = await client.listTools();
    assert.ok(result.tools, 'Should receive tools list');
    assert.ok(Array.isArray(result.tools), 'Tools should be an array');
  });

  it('should connect to second stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-2');
    clients.push(client);

    assert.ok(client, 'Client should be created');

    // Verify client is functional
    const result = await client.listTools();
    assert.ok(result.tools, 'Should receive tools list');
    assert.ok(Array.isArray(result.tools), 'Tools should be an array');
  });

  it('should connect to multiple servers simultaneously', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const [client1, client2] = await Promise.all([registry.connect('test-stdio-1'), registry.connect('test-stdio-2')]);

    clients.push(client1, client2);

    assert.ok(client1, 'First client should be created');
    assert.ok(client2, 'Second client should be created');
  });

  it('should throw error for nonexistent server', async () => {
    await assert.rejects(
      async () => {
        await connectMcpClient(serversConfig, 'nonexistent');
      },
      /Server 'nonexistent' not found in config/,
      'Should throw error for unknown server'
    );
  });

  it('should handle concurrent connection requests to same server', async () => {
    // Simulate multiple tests trying to connect to same service concurrently
    if (!registry) throw new Error('Registry not initialized');
    const [c1, c2, c3] = await Promise.all([registry.connect('test-stdio-1'), registry.connect('test-stdio-1'), registry.connect('test-stdio-1')]);

    clients.push(c1, c2, c3);

    assert.ok(c1, 'First connection should succeed');
    assert.ok(c2, 'Second connection should succeed');
    assert.ok(c3, 'Third connection should succeed');
  });

  it('should list tools from stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

    const tools = await client.listTools();
    const echoTool = tools.tools.find((t) => t.name === 'echo');

    assert.ok(echoTool, 'Should have echo tool');
    assert.strictEqual(echoTool?.description, 'Echoes back the provided message');
  });

  it('should list prompts from stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

    const prompts = await client.listPrompts();
    const echoPrompt = prompts.prompts.find((p) => p.name === 'echo');

    assert.ok(echoPrompt, 'Should have echo prompt');
    assert.strictEqual(echoPrompt?.description, 'Creates a prompt to process a message');
  });

  it('should get prompt from stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

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

  it('should list resources from stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

    const resources = await client.listResources();
    const echoResource = resources.resources.find((r) => r.name === 'echo');

    assert.ok(echoResource, 'Should have echo resource');
    assert.strictEqual(echoResource?.description, 'Echoes back messages as resources');
  });

  it('should read resource from stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

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

  it('should call tools on stdio server', async () => {
    if (!registry) throw new Error('Registry not initialized');
    const client = await registry.connect('test-stdio-1');
    clients.push(client);

    const invocation = await client.callTool({ name: 'echo', arguments: { message: 'test-message' } });
    const result = invocation.raw();

    const content = (result.content ?? []) as unknown[];
    assert.ok(content.length > 0, 'Should have content');
    const textContent = content[0] as { type: string; text: string };
    if (!textContent) throw new Error('Expected content at index 0');
    assert.strictEqual(textContent.type, 'text');
    assert.ok(textContent.text.includes('test-message'), 'Should echo message');
  });
});
