/**
 * Integration tests for ExistingProcessTransport
 *
 * Tests that we can connect to already-started processes using ExistingProcessTransport.
 * This transport is used when registry.connect() detects a server is already running
 * in the registry (instead of spawning a new process).
 *
 * No mocks - uses real started processes via createServerRegistry().
 */

import assert from 'assert';
import * as path from 'path';
import type { ManagedClient } from '../../../src/client-helpers.ts';
import type { ServerRegistry, ServersConfig } from '../../../src/index.ts';
import { createServerRegistry } from '../../../src/spawn/spawn-servers.ts';

describe('ExistingProcessTransport', () => {
  let registry: ServerRegistry | undefined;
  let client1: ManagedClient | undefined;
  let client2: ManagedClient | undefined;

  const testCwd = process.cwd();

  before(async () => {
    // Start servers with stdio transport
    const serversConfig: ServersConfig = {
      'test-server-1': {
        command: 'node',
        args: [path.join(testCwd, 'test/lib/servers/echo-stdio.ts')],
      },
      'test-server-2': {
        command: 'node',
        args: [path.join(testCwd, 'test/lib/servers/minimal-stdio.ts')],
      },
    };

    registry = createServerRegistry(serversConfig);
  });

  after(async () => {
    // Clean up connections
    if (client1) {
      await client1.close();
      client1 = undefined;
    }
    if (client2) {
      await client2.close();
      client2 = undefined;
    }

    // Close registry (handles all servers)
    if (registry) {
      await registry.close();
      registry = undefined;
    }
  });

  it('should connect to already-started server using ExistingProcessTransport', async () => {
    if (!registry) throw new Error('Registry not initialized');

    // This should use ExistingProcessTransport internally because the server is already running
    client1 = await registry.connect('test-server-1');

    // Verify we can communicate
    const tools = await client1.listTools();
    assert.ok(tools.tools.length > 0, 'Should be able to list tools from started server');

    // Verify we got the echo server's tools
    const echoTool = tools.tools.find((t) => t.name === 'echo');
    assert.ok(echoTool, 'Should have echo tool from echo-stdio server');
  });

  it('should support multiple concurrent connections to same started server', async () => {
    if (!registry) throw new Error('Registry not initialized');

    // Both connections should use ExistingProcessTransport to the same process
    const [c1, c2] = await Promise.all([registry.connect('test-server-1'), registry.connect('test-server-1')]);

    try {
      // Both should work independently
      const [tools1, tools2] = await Promise.all([c1.listTools(), c2.listTools()]);

      assert.ok(tools1.tools.length > 0);
      assert.ok(tools2.tools.length > 0);
      assert.strictEqual(tools1.tools.length, tools2.tools.length, 'Both connections should see same tools');
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  it('should be able to call tools through ExistingProcessTransport', async () => {
    if (!registry) throw new Error('Registry not initialized');
    client1 = await registry.connect('test-server-1');

    // Call the echo tool
    const wrapped = await client1.callTool({
      name: 'echo',
      arguments: { message: 'test-message' },
    });

    const result = wrapped.raw();
    const content = (result.content ?? []) as unknown[];
    assert.ok(content.length > 0);
    assert.strictEqual(content.length, 1);

    const textContent = content[0] as { type: string; text: string };
    if (!textContent) throw new Error('Expected content at index 0');
    assert.strictEqual(textContent.type, 'text');

    // Parse the echoed response (echo-stdio returns { echo: "Tool echo: message" })
    const parsed = JSON.parse(textContent.text);
    assert.strictEqual(parsed.echo, 'Tool echo: test-message');
  });

  it('should work with different servers in same registry', async () => {
    if (!registry) throw new Error('Registry not initialized');

    // Connect to first server (echo-stdio has 1 tool)
    client1 = await registry.connect('test-server-1');
    const tools1 = await client1.listTools();

    // Connect to second server (minimal-stdio has 2 tools: ping, echo)
    client2 = await registry.connect('test-server-2');
    const tools2 = await client2.listTools();

    // Different servers should have different tool sets
    assert.ok(tools1.tools.length > 0);
    assert.ok(tools2.tools.length > 0);

    // Verify we're actually getting different tool sets (minimal-stdio has more tools)
    assert.ok(tools2.tools.length > tools1.tools.length, 'minimal-stdio should have more tools than echo-stdio');
  });

  it('should handle resources through ExistingProcessTransport', async () => {
    if (!registry) throw new Error('Registry not initialized');
    client1 = await registry.connect('test-server-1');

    // List resources
    const resources = await client1.listResources();
    assert.ok(resources.resources.length > 0, 'Should be able to list resources');

    // Read a resource
    const echoResource = resources.resources.find((r) => r.uri.startsWith('echo://'));
    assert.ok(echoResource, 'Should have echo resources');

    const resource = await client1.readResource({ uri: 'echo://test-message' });
    const content = resource.raw();
    assert.ok(content.contents);
    assert.ok(content.contents.length > 0);
  });

  it('should handle prompts through ExistingProcessTransport', async () => {
    if (!registry) throw new Error('Registry not initialized');
    client1 = await registry.connect('test-server-1');

    // List prompts
    const prompts = await client1.listPrompts();
    assert.ok(prompts.prompts.length > 0, 'Should be able to list prompts');

    // Get a prompt
    const echoPrompt = prompts.prompts.find((p) => p.name === 'echo');
    assert.ok(echoPrompt, 'Should have echo prompt');

    const prompt = await client1.getPrompt({
      name: 'echo',
      arguments: { message: 'test-prompt-message' },
    });

    const result = prompt.raw();
    assert.ok(result.messages);
    assert.ok(result.messages.length > 0);
  });

  it('should properly close connections without killing shared process', async () => {
    if (!registry) throw new Error('Registry not initialized');

    // Create two connections to same server
    const c1 = await registry.connect('test-server-1');
    const c2 = await registry.connect('test-server-1');

    // Close first connection
    await c1.close();

    // Second connection should still work
    const tools = await c2.listTools();
    assert.ok(tools.tools.length > 0, 'Second connection should still work after first is closed');

    // Server should still be running in registry
    assert.ok(registry.servers.has('test-server-1'), 'Server should still be in registry');

    await c2.close();
  });
});
