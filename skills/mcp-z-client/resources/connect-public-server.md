# Connect to a public server

```typescript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({
  todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' },
});

try {
  const client = await registry.connect('todoist');

  const tools = await client.listTools();
  console.log('Available tools:', tools.tools.map((tool) => tool.name));

  await client.callTool('add-tasks', {
    tasks: [{ content: 'My task', priority: 4 }],
  });

  const result = await client.callTool('find-tasks', {
    searchText: 'My task',
  });
  console.log(result.text());
} finally {
  await registry.close();
}
```
