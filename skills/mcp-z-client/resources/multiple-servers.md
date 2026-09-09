# Use multiple servers

```typescript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({
  'echo-1': { command: process.execPath, args: ['server1.js'] },
  'echo-2': { command: process.execPath, args: ['server2.js'] },
});

try {
  const [client1, client2] = await Promise.all([
    registry.connect('echo-1'),
    registry.connect('echo-2'),
  ]);

  await client1.callTool('echo', { message: 'Hello' });
  await client2.callTool('echo', { message: 'World' });
} finally {
  await registry.close();
}
```
