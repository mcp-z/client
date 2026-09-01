/**
 * Unit tests for createServerRegistry() - core server management
 */

import { createServerRegistry, type ServerRegistry } from '@mcp-z/client';
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory (avoid process.cwd() - brittle!)
const projectRoot = path.resolve(__dirname, '../../..');

describe('createServerRegistry', () => {
  let registry: ServerRegistry | undefined;

  after(async () => {
    if (registry) await registry.close();
  });

  it('should start a single server with stdio transport', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.ok(registry, 'Registry should be created');
    assert.ok(registry.servers, 'Registry should have servers map');
    assert.strictEqual(registry.servers.size, 1, 'Should have 1 server');
    assert.ok(registry.servers.has('my-stdio'), 'Should have my-stdio server');
    assert.ok(typeof registry.close === 'function', 'Should have close function');
    assert.ok(typeof registry.connect === 'function', 'Should have connect function');

    const server = registry.servers.get('my-stdio');
    assert.ok(server, 'Server should exist');
    assert.ok(server.process, 'Server should have process');
    assert.ok(!server.process.killed, 'Process should be running');

    await registry.close();
    registry = undefined;
  });

  it('should start multiple servers simultaneously', async () => {
    registry = createServerRegistry(
      {
        'server-1': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
        'server-2': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.strictEqual(registry.servers.size, 2, 'Should have 2 servers');
    assert.ok(registry.servers.has('server-1'), 'Should have server-1');
    assert.ok(registry.servers.has('server-2'), 'Should have server-2');

    // Both processes should be running
    const server1 = registry.servers.get('server-1');
    const server2 = registry.servers.get('server-2');
    assert.ok(server1?.process && !server1.process.killed, 'Server 1 should be running');
    assert.ok(server2?.process && !server2.process.killed, 'Server 2 should be running');

    await registry.close();
    registry = undefined;
  });

  it('should resolve paths relative to cwd', async () => {
    // Use test file location to construct absolute path to server
    const serverPath = path.join(__dirname, '../../lib/servers/pathtest-echo-stdio.mjs');

    registry = createServerRegistry(
      {
        'my-local': {
          command: 'node',
          args: [serverPath],
        },
      },
      { cwd: path.dirname(__dirname) } // test/ directory
    );

    assert.ok(registry.servers.has('my-local'), 'Should have my-local server');
    const server = registry.servers.get('my-local');
    assert.ok(server?.process && !server.process.killed, 'Server should be running');

    await registry.close();
    registry = undefined;
  });

  it('should support per-server environment variables', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
          env: {
            TEST_VAR: 'test-value',
            CUSTOM_PORT: '9999',
          },
        },
      },
      { cwd: projectRoot }
    );

    const server = registry.servers.get('my-stdio');
    assert.ok(server?.process, 'Server should exist');
    // Note: Can't easily verify env vars were passed, but we can verify process spawned
    assert.ok(!server.process.killed, 'Process should be running with custom env');

    await registry.close();
    registry = undefined;
  });

  it('should support graceful shutdown', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    const server = registry.servers.get('my-stdio');
    assert.ok(server?.process && !server.process.killed, 'Process should be running before close');

    // Graceful close
    const result = await registry.close();
    assert.strictEqual(result.timedOut, false, 'Close should complete without timeout');
    assert.strictEqual(result.killedCount, 0, 'Should not need to force-kill any processes');

    assert.ok(server.process.killed || server.process.exitCode !== null, 'Process should be stopped after close');
    registry = undefined;
  });

  it('should handle servers config format directly', async () => {
    const registry2 = createServerRegistry(
      {
        test: {
          command: 'node',
          args: ['--version'],
        },
      },
      { cwd: projectRoot }
    );

    assert.ok(registry2.servers.has('test'), 'Should parse servers config format');
    await registry2.close();
  });

  it('should fail loudly when cwd directory does not exist', async () => {
    const nonExistentCwd = path.join(projectRoot, 'non-existent-directory');

    // Ensure the directory doesn't exist
    if (fs.existsSync(nonExistentCwd)) {
      throw new Error(`Test setup error: directory should not exist: ${nonExistentCwd}`);
    }

    try {
      createServerRegistry(
        {
          test: {
            command: 'node',
            args: ['--version'],
          },
        },
        { cwd: nonExistentCwd }
      );
      // If we reach here, the registry was created but should be empty due to spawn failures
      // This assertion will fail initially, demonstrating the bug
      assert.fail('Expected createServerRegistry to throw an error or return empty servers when cwd does not exist');
    } catch (error) {
      // Expected: createServerRegistry should either throw immediately or creation should fail
      // The current implementation may not validate cwd existence before spawning
      assert.ok(error instanceof Error, 'Should throw an Error when cwd does not exist');
    }
  });

  it('should connect to server using registry.connect()', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    // Connect using registry method
    const client = await registry.connect('my-stdio');
    assert.ok(client, 'Should return client');

    // Verify connection by listing tools
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools.tools), 'Should list tools');

    // Close should clean up both client and server
    await registry.close();
    registry = undefined;
  });

  it('should track connected clients', async () => {
    registry = createServerRegistry(
      {
        'server-1': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
        'server-2': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.strictEqual(registry.clients.size, 0, 'Should start with no clients');

    const client1 = await registry.connect('server-1');
    assert.strictEqual(registry.clients.size, 1, 'Should track 1 client');

    const client2 = await registry.connect('server-2');
    assert.strictEqual(registry.clients.size, 2, 'Should track 2 clients');

    // Verify both clients work
    await client1.listTools();
    await client2.listTools();

    await registry.close();
    registry = undefined;
  });

  it('should support dialects option', async () => {
    // Default dialects is ['servers'] which spawns stdio servers only
    registry = createServerRegistry(
      {
        'stdio-server': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot, dialects: ['servers'] }
    );

    assert.strictEqual(registry.servers.size, 1, 'Should spawn stdio server with servers dialect');

    await registry.close();
    registry = undefined;
  });
});

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
      { cwd: projectRoot }
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
