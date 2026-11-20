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
      start: {
        command: 'node',
        args: ['server.js'],
        stop: {
          command: 'node',
          args: ['request-server-stop.js', 'http://localhost:3000/admin/shutdown']
        }
      }
    }
  },
  { dialects: ['start'] }
);
```

`start.stop` is an optional application-specific cooperative shutdown command for a server started by this registry. It runs once during `registry.close()`, before the registry waits for the owned process to close. The stop command must use a mechanism implemented by that server; MCP HTTP has no server shutdown operation. Commands use argument arrays without a shell. `timeoutMs` bounds each cooperative wait for the stop command and owned process (five seconds by default); emergency termination has its own bounded wait. Without a stop command there is no portable HTTP shutdown protocol: POSIX requests the configured signal, while Windows waits for the direct child and then uses emergency termination of its process tree. External HTTP servers and client lease closure do not run the stop command.

Stdio shutdown sends EOF to the owned process first. If it remains open, POSIX sends the requested signal and waits again; Windows proceeds to bounded termination. POSIX shutdown tracks the detached process group. On Windows, emergency termination runs `taskkill /PID <pid> /T /F` on the owned child while it is still alive, so a server started through `cmd.exe` (a `.cmd` file, `npm`) is stopped with its launcher. The tree is taken from the live owned child, so on Windows a launcher that has already exited when the registry closes leaves anything it started outside the registry's reach. `timedOut` reports a missed cooperative window, and `killedCount` counts owned servers emergency-terminated (one per server, not per process).

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

`client.nativeClient` is the original SDK instance. The managed client is a separate view of the same connection; stdio clients also have registry leases. Closing a stdio lease releases its reference, while closing the native instance closes the connection directly.

### Response helpers

Tool, prompt, and resource calls return wrappers with:

- `json()` - Parse structured content
- `text()` - First text result

Responses expose typed MCP fields: tools have `content`, `structuredContent`, and `isError`; prompts have `description` and `messages`; resources have `contents`. Each response exposes `_meta`. These properties retain non-text messages, roles, binary data, MIME types, and all entries. `JSON.stringify(response)` serializes the original MCP result, including server extensions. `json()` continues to convert content rather than return the protocol envelope.

An awaited managed tool call rejects an MCP `isError` result with `ToolResponseError`; its `response` retains the complete error result. Protocol and transport errors also reject. Conversion failures occur when calling `json()` or `text()`.

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

## OAuth

When an HTTP server publishes OAuth metadata and offers dynamic client registration (DCR) or client metadata documents (CIMD), `connect` signs in before it connects: it opens your browser, waits for the sign-in on a loopback address (`http://127.0.0.1:<port>/callback`), and saves the tokens. How the client identifies itself is up to you:

- By default it registers itself (DCR) and keeps the registration with the tokens; a registration the server rejects is replaced by a new one. The registration carries a `client_name` only if you pass `dcrAuthenticator: { clientName }`.
- If you pass `dcrAuthenticator: { clientMetadataUrl }`, the client sends that URL as its `client_id` to servers that accept client metadata documents, and registers on the others. Nothing is registered at a CIMD server and no client secret is stored. A server that offers only CIMD and gets no `clientMetadataUrl` fails with "Incompatible auth server: does not support dynamic client registration".

A server that offers neither, such as one that needs a pre-registered client id, is connected to without signing in.

Pass a token store via `dcrAuthenticator`:

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

Without a `tokenStore`, sign-ins are saved in `.mcp-z/tokens.json` in the working directory. A custom `tokenStore` must be a keyv 6 `Keyv` whose store can list its keys (memory, file and sqlite can); `deleteTokens()` needs that to find a server's tokens. Sign-ins saved by keyv 5 in the default store are moved to the keyv 6 format on first use, and sign-ins saved by earlier releases keep working.

### Client metadata document

`clientMetadataUrl` must be an https URL, with a path, of a JSON document that you, the application's owner, host and keep at that URL (it is the client's identity at every server). It lists `redirect_uris` `["http://127.0.0.1/callback"]` (the client calls back on a random port, which a server must accept for a loopback address), `token_endpoint_auth_method` `"none"` and `application_type` `"native"`. The server fetches the document, so it must be reachable from the server. Servers built on oauth-google or oauth-microsoft before 2.4.3 advertise CIMD but refuse a redirect on a port the document does not list, so do not pass `clientMetadataUrl` for them: they register.

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
