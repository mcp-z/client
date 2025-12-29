# @mcp-z/client

Docs: https://mcp-z.github.io/client
Programmatic MCP client for spawning, connecting to, and calling MCP servers.

## Common uses

- Run MCP tools from scripts
- Connect to multiple servers in one process
- Integration tests for MCP servers

## Install

```bash
npm install --save-dev @mcp-z/client
```

Requires Node.js >= 22.

## Quick start

```ts
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({
  todoist: { url: 'https://ai.todoist.net/mcp', type: 'http' }
});

const client = await registry.connect('todoist');
await client.callTool('add-tasks', {
  tasks: [{ content: 'Learn MCP', priority: 4 }]
});

await registry.close();
```

## Configuration

MCP supports stdio and HTTP.

**Stdio**
```ts
{
  echo: {
    command: 'node',
    args: ['server.js'],
    env: { LOG_LEVEL: 'info' }
  }
}
```

**HTTP**
```ts
{
  todoist: {
    type: 'http',
    url: 'https://ai.todoist.net/mcp',
    headers: { Authorization: 'Bearer token' }
  }
}
```

## API basics

- `createServerRegistry(config, options?)`
- `registry.connect(name)`
- `client.callTool(name, args)`
- `client.listTools()` / `client.listResources()` / `client.listPrompts()`
- `registry.close()`

## OAuth (DCR)

If an HTTP server supports DCR, pass a token store:

```ts
import Keyv from 'keyv';
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({
  todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' }
});

const client = await registry.connect('todoist', {
  dcrAuthenticator: { tokenStore: new Keyv() }
});
```

## Requirements

- Node.js >= 22
