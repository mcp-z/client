# @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Common uses

- Run MCP tools from scripts
- Connect to multiple servers in one process
- Integration tests for MCP servers

## Install

```bash
npm install --save-dev @mcp-z/client
```

Requires Node.js >= 22.

## Agent skill

Install the repository's `mcp-z-client` skill globally when an agent will write code that consumes this package:

```bash
npx skills add https://github.com/mcp-z/client.git -g -s mcp-z-client
```

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

## Protocol version negotiation

By default a connect performs the plain 2025 MCP connect sequence. Pass `versionNegotiation` to negotiate the protocol revision instead:

```ts
// Probe the server first; connect at the newest revision it offers,
// falling back to the 2025 sequence when it cannot serve the modern era
const client = await registry.connect('modern-server', {
  versionNegotiation: { mode: 'auto' }
});

// Require the 2026-07-28 revision; a server that cannot serve it fails
// the connect with SdkErrorCode.EraNegotiationFailed
const pinned = await registry.connect('strict-server', {
  versionNegotiation: { mode: { pin: '2026-07-28' } }
});
```

After connecting, `client.getProtocolEra()` returns `'modern'` or `'legacy'` and `client.getNegotiatedProtocolVersion()` the revision the server settled on.

Note: with `mode: 'auto'` against a stdio server, a legacy server that never answers the `server/discover` probe costs the full request timeout (60s) before the client falls back to the 2025 sequence. The probe ends fast when the server answers it at all — with any reply, even a "method not found" error.

## Requirements

- Node.js >= 22

### Documentation

[API Docs](https://mcp-z.github.io/client)
