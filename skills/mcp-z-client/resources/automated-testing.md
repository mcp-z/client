# Test an MCP server

This integration test exercises the built server through its public MCP interface.

```typescript
import { createServerRegistry, type ServerRegistry } from '@mcp-z/client';
import assert from 'assert';

describe('MCP server', () => {
  let registry: ServerRegistry;

  before(() => {
    registry = createServerRegistry(
      {
        server: {
          command: process.execPath,
          args: ['bin/server.js'],
        },
      },
      { cwd: process.cwd() },
    );
  });

  after(async () => {
    await registry.close();
  });

  it('serves its tools', async () => {
    const client = await registry.connect('server');
    const tools = await client.listTools();

    assert.ok(tools.tools.some((tool) => tool.name === 'ping'));

    const response = await client.callTool('ping');
    assert.deepStrictEqual(response.json(), { result: 'pong' });
  });
});
```

If the server writes test-owned state, place it under the package's `.tmp/` directory and remove it after closing the registry.
