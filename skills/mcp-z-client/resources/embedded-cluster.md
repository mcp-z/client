# Embed a server cluster

```typescript
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServerRegistry } from '@mcp-z/client';

const configPath = resolve('.mcp.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const registry = createServerRegistry(config.mcpServers, {
  cwd: dirname(configPath),
});

try {
  const gmail = await registry.connect('gmail');
  const sheets = await registry.connect('sheets');

  const response = await gmail.callTool('messages-search', {
    query: 'from:newsletter@example.com',
  });
  const { result } = response.json<{ result: { rows: unknown[][] } }>();

  await sheets.callTool('rows-append', {
    id: 'SPREADSHEET_ID',
    gid: '0',
    rows: result.rows,
  });
} finally {
  await registry.close();
}
```
