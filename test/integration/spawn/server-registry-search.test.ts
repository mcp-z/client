import assert from 'assert';
import type { ServerRegistry, ServersConfig } from '../../../src/index.ts';
import { createServerRegistry } from '../../../src/spawn/spawn-servers.ts';

describe('ServerRegistry searchCapabilities', () => {
  let registry: ServerRegistry | undefined;

  beforeEach(async () => {
    const config: ServersConfig = {
      'echo-server': {
        command: 'node',
        args: ['test/lib/servers/echo-stdio.mjs'],
      },
    };
    registry = createServerRegistry(config, { cwd: process.cwd() });
  });

  afterEach(async () => {
    if (registry) {
      await registry.close();
      registry = undefined;
    }
  });

  it('searches without pre-connected clients', async () => {
    if (!registry) {
      throw new Error('Registry not initialized');
    }
    const response = await registry.searchCapabilities('echo');
    assert.ok(response.results.length > 0, 'Should return search results');
    const hasEchoTool = response.results.some((result) => result.name === 'echo');
    assert.ok(hasEchoTool, 'Should include echo tool in results');
  });

  it('filters by server name and connects lazily', async () => {
    if (!registry) {
      throw new Error('Registry not initialized');
    }
    const response = await registry.searchCapabilities('echo', { servers: ['echo-server'] });
    assert.ok(response.results.every((result) => result.server === 'echo-server'));
  });

  it('throws when searching unknown servers', async () => {
    if (!registry) {
      throw new Error('Registry not initialized');
    }
    // Captured because the closure below outlives the narrowing on the mutable binding.
    const activeRegistry = registry;
    await assert.rejects(async () => activeRegistry.searchCapabilities('echo', { servers: ['does-not-exist'] }), /unknown server/i);
  });
});
