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
  todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' }
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

**HTTP with start block (extension)**

Use `dialects: ['start']` to spawn HTTP servers with `start` blocks.

```ts
const registry = createServerRegistry(
  {
    api: {
      type: 'http',
      url: 'http://localhost:3000/mcp',
      start: { command: 'node', args: ['server.js'] }
    }
  },
  { dialects: ['start'] }
);
```

## API overview

### Registry

- `createServerRegistry(config, options?)`
- `registry.connect(name, options?)`
- `registry.searchCapabilities(query, options?)`
- `registry.close()`

### Managed client

- `client.callTool(name, args)`
- `client.getPrompt(name, args)`
- `client.readResource(uri)`
- `client.listTools()` / `client.listResources()` / `client.listPrompts()`
- `client.callToolRaw()` / `client.getPromptRaw()` / `client.readResourceRaw()` (raw SDK responses)

### Response helpers

Tool, prompt, and resource calls return wrappers with:

- `json()` - Parse structured content
- `text()` - First text result
- `raw()` - Raw MCP response

## Examples

### Call a tool

```ts
const response = await client.callTool('drive-search', { query: 'Q4 Reports' });
const data = response.json();
```

### Get a prompt

```ts
const prompt = await client.getPrompt('query-syntax', { service: 'gmail' });
console.log(prompt.text());
```

### Read a resource

```ts
const resource = await client.readResource('mcp-pdf://abc123');
console.log(resource.text());
```

### Search capabilities

```ts
const results = await registry.searchCapabilities('message send', {
  types: ['tool'],
  servers: ['gmail', 'outlook']
});
```

## createServerRegistry options

- `cwd` - Working directory for spawned processes (default: `process.cwd()`)
- `env` - Base env for all servers (if set, `process.env` is not merged)
- `dialects` - Which servers to spawn: `['servers']` (stdio), `['start']` (HTTP start blocks), or both

## OAuth (DCR)

If an HTTP server supports DCR, pass a token store via `dcrAuthenticator`:

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
