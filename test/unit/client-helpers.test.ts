import type { ManagedClient } from '@mcp-z/client';
import { createServerRegistry, type ServerRegistry } from '@mcp-z/client';
import assert from 'assert';

describe('ManagedClient helper overloads', () => {
  let registry: ServerRegistry | undefined;
  let client: ManagedClient;

  before(async () => {
    registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    client = await registry.connect('test-server');
  });

  after(async () => {
    if (registry) {
      await registry.close();
    }
  });

  it('exposes serverName metadata', () => {
    assert.strictEqual(client.serverName, 'test-server');
  });

  it('supports callTool(toolName, args)', async () => {
    const response = await client.callTool('ping', {});
    const result = response.json<{ result: string }>();
    assert.strictEqual(result.result, 'pong');
  });

  it('supports readResource(uri)', async () => {
    const result = await client.readResource('test://hello');
    const text = result.text();
    assert.ok(text.includes('Resource content'), 'content should include resource text');
  });

  it('supports getPrompt(name, args)', async () => {
    const prompt = await client.getPrompt('greet', { name: 'Tester' });
    const text = prompt.text();
    assert.ok(text.includes('Hello'), 'should include prompt text');
  });
});
