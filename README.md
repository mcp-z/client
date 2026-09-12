# @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Common uses

- Run MCP tools from scripts
- Connect to multiple servers in one process
- Integration tests for MCP servers

## Install

```bash
npm install @mcp-z/client
```

Requires Node.js >= 20.

## Quick start

Create a local stdio server that exposes an `echo` tool:

```bash
npm install @modelcontextprotocol/sdk zod
```

Save this as `echo-server.mjs`:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool('echo', { inputSchema: { message: z.string() } }, async ({ message }) => ({
  content: [{ type: 'text', text: message }]
}));
await server.connect(new StdioServerTransport());
```

Connect to it and print the returned text:

```ts
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({ echo: { command: 'node', args: ['echo-server.mjs'] } });
const client = await registry.connect('echo');
const response = await client.callTool('echo', { message: 'hello MCP' });
console.log(response.text()); // hello MCP
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

With `mode: 'auto'` against a stdio server, a legacy server that never answers the `server/discover` probe costs the full 60-second request timeout before the client falls back to the 2025 sequence. Any reply, including a "method not found" error, ends the probe.

## Requirements

- Node.js >= 20

## Agent skill

If a coding agent will use this package, install its agent guidance globally:

```bash
npx skills add https://github.com/mcp-z/client.git -g -s mcp-z-client
```

## Documentation

[API Docs](https://mcp-z.github.io/client)
