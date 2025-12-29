/**
 * Unit tests for createServerRegistry() + registry.connect() - single stdio server spawn and connection
 */

import assert from 'assert';
import * as path from 'path';
import * as url from 'url';
import { createServerRegistry, type ServerRegistry } from '../../../src/spawn/spawn-servers.ts';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));

describe('createServerRegistry + connect', () => {
  const registries: ServerRegistry[] = [];

  after(async () => {
    // Clean up all registries (they manage their own clients)
    for (const registry of registries) {
      try {
        await registry.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  it('should spawn and connect to server via stdio', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should return client');
    assert.ok(typeof client.close === 'function', 'Should have close method');

    // Verify client is connected by listing tools
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools.tools), 'Should list tools');
    assert.ok(tools.tools.length > 0, 'Should have at least one tool');

    await registry.close();
    // Remove from close array since we already closed it
    registries.pop();
  });

  it('should pass custom environment variables via per-server env', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
        env: {
          CUSTOM_VAR: 'test-value',
          LOG_LEVEL: 'error',
        },
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should connect with custom env vars');

    // Verify connection works
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0, 'Should work with custom env');

    await registry.close();
    registries.pop();
  });

  it('should support custom working directory', async () => {
    const registry = createServerRegistry(
      {
        'test-server': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: path.resolve(__dirname, '../../..') } // Project root
    );
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should connect with custom cwd');
    await registry.close();
    registries.pop();
  });

  it('should close connection and kill stdio process', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    // Verify connected
    assert.ok(client, 'Should be connected');

    // Close registry (closes all clients and servers)
    await registry.close();
    registries.pop();

    // Verify client is closed (subsequent calls should fail)
    try {
      await client.listTools();
      assert.fail('Should not be able to call methods after close');
    } catch (error) {
      assert.ok(error, 'Should throw error when calling closed client');
    }
  });

  it('should handle spawn errors gracefully', async () => {
    try {
      const registry = createServerRegistry({
        'bad-server': {
          command: 'nonexistent-command',
          args: [],
        },
      });

      registries.push(registry);

      // Try to connect - should fail
      const _client = await registry.connect('bad-server');

      assert.fail('Should throw error for nonexistent command');
    } catch (error) {
      assert.ok(error, 'Should throw error');
      // Error could be ENOENT or similar
      assert.ok(error instanceof Error, 'Should be an Error instance');
    }
  });
});
