# MCP Examples for AI Agents

Quick-start examples for building scripts with MCP servers using `@mcp-z/client`.

## Install

```bash
npm install @mcp-z/client
```

## Quick Peek

```javascript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry({ todoist: { url: 'https://ai.todoist.net/mcp' } });
const client = await registry.connect('todoist');
await client.callTool('add-tasks', { tasks: [{ content: 'My task', priority: 4 }] });
await registry.close();
```

## Full Example: Todoist Task Management

```javascript
/**
 * This example shows how to use @mcp-z/client to manage tasks via Todoist.
 * Copy this and modify it for your needs!
 *
 * PREREQUISITES:
 *   npm install @mcp-z/client                     # the client library for typescript / javascript
 *   npm install @mcp-z/cli                        # the cli command is "mcpz". Run "mcpz --help" for a full list of commands
 *
 * DISCOVERY (find tools before writing code):
 *   npx @mcp-z/cli search "add task"              # Find the tool you need
 *   npx @mcp-z/cli inspect --servers todoist      # See all available tools
 *   npx @mcp-z/cli call-tool todoist add-tasks '{}' # Test it works
 *
 * TIP: Or load your own .mcp.json file instead of inline config:
 *   const config = JSON.parse(fs.readFileSync('.mcp.json', 'utf-8'));
 *   const registry = createServerRegistry(config.mcpServers);
 */

import { createServerRegistry } from '@mcp-z/client';

// Configure your MCP servers (inline, or load from .mcp.json file)
const servers = {
  todoist: {
    url: 'https://ai.todoist.net/mcp'
  }
};

async function main() {
  const registry = createServerRegistry(servers);

  try {
    console.log('🚀 Connecting to Todoist...');
    const client = await registry.connect('todoist');

    console.log('✅ Connected! Adding task...');

    // Add a task to Todoist
    // See available tools: npx @mcp-z/cli inspect --servers todoist
    await client.callTool('add-tasks', {
      tasks: [
        {
          content: 'Learn MCP with @mcp-z/client',
          projectId: undefined, // Optional: add to specific project
          priority: 4           // 1-4, where 4 is highest
        }
      ]
    });

    console.log('✅ Task added successfully!');

    // List tasks (discovery first: npx @mcp-z/cli inspect --servers todoist)
    console.log('\n📋 Fetching tasks...');
    const findResponse = await client.callTool('find-tasks', {
      searchText: 'Learn MCP'
    });

    console.log('✅ Tasks found:', findResponse.json());

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    console.log('🔒 Closing connection...');
    await registry.close();
    console.log('✅ Done!');
  }
}

main();
```

## The Pattern

Once you understand this example, you understand them all:

```javascript
import { createServerRegistry } from '@mcp-z/client';

const registry = createServerRegistry(servers);  // Configure servers
try {
  const client = await registry.connect('server-name');  // Connect
  await client.callTool('tool-name', { /* args */ });    // Use tools
} finally {
  await registry.close();  // Always cleanup
}
```

**Configure servers inline or from `.mcp.json`:**
```javascript
// Inline config
const servers = { todoist: { url: '...' } };

// Or load from file
const config = JSON.parse(fs.readFileSync('.mcp.json', 'utf-8'));
const servers = config.mcpServers;
```

## Discovery Workflow

**Before writing code, discover what's available:**

1. **Search for tools:**
   ```bash
   npx @mcp-z/cli search "add task"
   ```

2. **Inspect a server:**
   ```bash
   npx @mcp-z/cli inspect --servers todoist
   ```

3. **Test a tool:**
   ```bash
   npx @mcp-z/cli call-tool todoist add-tasks '{"tasks":[{"content":"Test"}]}'
   ```

4. **Write your script** using `@mcp-z/client`

## Available Public Servers

These servers don't need special setup - just use their URLs:

- **Todoist**: `https://ai.todoist.net/mcp`
- **Notion**: `https://mcp.notion.com/mcp`

Private servers (require authentication):
- Google Sheets, Drive, Gmail, Outlook, PDF (contact us for access)

## Need Help?

1. **Discover tools**: `npx @mcp-z/cli search <query>`
2. **See all tools**: `npx @mcp-z/cli inspect --servers <server>`
3. **Test first**: `npx @mcp-z/cli call-tool <server> <tool> '{}'`

Once you know a tool works via CLI, use it in your script with `@mcp-z/client`!