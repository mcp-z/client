# Test Servers

Docs: https://mcp-z.github.io/client
This directory contains MCP test servers for testing @mcp-z/cli functionality. Each server demonstrates a specific transport type and serves as a living example for library users.

## Server Overview

### echo-stdio.ts
**Purpose**: Full MCP SDK demonstration with stdio transport
**Transport**: stdin/stdout process communication
**Features**:
- Complete MCP SDK implementation (McpServer, StdioServerTransport)
- Echo tool with JSON-structured responses
- Echo resource for URI-based access
- Echo prompt for message processing

**Usage**:
```bash
node test/lib/servers/echo-stdio.ts
```

**Example Config**:
```json
{
  "mcpServers": {
    "my-stdio-server": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/echo-stdio.ts"]
    }
  }
}
```

---

### echo-http.ts
**Purpose**: Full MCP SDK demonstration with http transport
**Transport**: HTTP with Server-Sent Events (SSE)
**Features**:
- Complete MCP SDK implementation (McpServer, StreamableHTTPServerTransport)
- Echo tool with JSON-structured responses
- Echo resource and prompt
- Configurable port via --port argument

**Usage**:
```bash
node test/lib/servers/echo-http.ts --port 3000
```

**Example Config**:
```json
{
  "mcpServers": {
    "my-http-server": {
      "type": "http",
      "url": "http://localhost:3000"
    }
  }
}
```

---

### minimal-stdio.ts
**Purpose**: Minimal hand-rolled JSON-RPC implementation for low-level testing
**Transport**: stdin/stdout process communication
**Features**:
- No MCP SDK dependency (hand-rolled JSON-RPC)
- Minimal protocol support (initialize, tools/list, tools/call, resources/list, prompts/list)
- Useful for testing connection logic, env vars, shutdown behavior

**Usage**:
```bash
node test/lib/servers/minimal-stdio.ts
```

**When to use**: Low-level tests that need to verify stdio connection logic without MCP SDK overhead.

---

### pathtest-stdio.ts
**Purpose**: Validate relative path resolution in spawn-cluster
**Transport**: stdin/stdout process communication
**Features**:
- Standard MCP SDK stdio server
- Used to verify cwd parameter works correctly

**Usage**:
```typescript
spawnCluster({
  mcpServers: {
    'test': {
      command: 'node',
      args: ['servers/pathtest-stdio.ts']  // Relative path
    }
  }
}, { cwd: 'test/lib' });  // Working directory for resolution
```

---

## Naming Convention

All servers follow the pattern: `{purpose}-{transport}.ts`

- **Purpose**: What the server demonstrates (echo, minimal, pathtest)
- **Transport**: How it communicates (stdio, http)

## Consistency Guidelines

All test servers follow these standards:

1. **Structured Responses**: Echo tools return JSON.stringify() of structured objects
2. **CLI Arguments**: Network servers accept --port for explicit port binding
3. **Graceful Shutdown**: All servers handle SIGINT/SIGTERM
4. **Clear Headers**: Extensive comments explain PURPOSE and FEATURES
5. **Standalone Runnable**: Each server can be run manually for debugging

## Common Response Format

Echo tools return JSON-structured responses:

```json
{
  "type": "success",
  "message": "original message",
  "echo": "Tool echo: original message"
}
```

This format is used by `client.callTool()` and tests that parse tool responses.

## Troubleshooting

### Server Won't Start
- Check port is not already in use: `lsof -i :PORT`
- Verify Node.js version >= 24 (native TypeScript support)
- Run with explicit port: `node echo-http.ts --port 3001`

### Connection Timeouts
- Verify server is actually listening (check console output)
- For stdio: check process spawned successfully
- For HTTP: ensure server is listening on specified port

### Protocol Errors
- Verify client and server use same MCP SDK version
- Check initialize handshake completes (client.connect() resolves)
- Use minimal-stdio.ts to isolate MCP SDK issues

## Transport Inference

The CLI automatically infers transport type from URL protocol:

- `http://` or `https://` → Streamable-HTTP transport
- No URL → stdio transport (default)

Both transport types can be spawned and tested locally:
- **stdio**: Uses MCP SDK's `StdioServerTransport`
- **HTTP**: Uses MCP SDK's `StreamableHTTPServerTransport`

See `src/lib/connect-mcp-client.ts` for implementation details.
