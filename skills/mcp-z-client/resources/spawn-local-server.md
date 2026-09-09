# Spawn a local server

```typescript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry(
  {
    'my-server': {
      command: process.execPath,
      args: ['my-mcp-server.js'],
      env: { LOG_LEVEL: 'info' },
    },
  },
  { cwd: process.cwd() },
);

try {
  const client = await registry.connect('my-server');
  await client.callTool('process-data', { input: 'test' });
} finally {
  await registry.close();
}
```
