# Discover capabilities

```typescript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({
  todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' },
});

try {
  await registry.connect('todoist');

  const results = await registry.searchCapabilities('add task', {
    types: ['tool'],
  });
  console.log(results.results);
} finally {
  await registry.close();
}
```
