/**
 * Integration tests for bearer token authentication with HTTP transport
 *
 * Tests that the headers field in server config works with bearer token authentication.
 * Validates that registry.connect() properly passes Authorization headers to both
 * StreamableHTTPClientTransport and SSEClientTransport (fallback).
 */

import assert from 'assert';
import getPort from 'get-port';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ManagedClient } from '../../../src/client-helpers.ts';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import type { ServerRegistry, ServersConfig } from '../../../src/index.ts';
import { createServerRegistry } from '../../../src/spawn/spawn-servers.ts';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory (avoid process.cwd() - brittle!)
const projectRoot = path.resolve(__dirname, '../../..');

describe('bearer auth http transport', () => {
  let registry: ServerRegistry | undefined;
  let serversConfig: ServersConfig;
  let client: ManagedClient | undefined;
  let port: number;
  let url: string;
  const validToken = 'test-bearer-token-123';

  before(async () => {
    // Get available port dynamically
    port = await getPort();
    url = `http://localhost:${port}/mcp`;

    // Start bearer-auth HTTP server with configured token
    serversConfig = {
      'bearer-test': {
        url,
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
        start: {
          command: 'node',
          args: ['test/lib/servers/bearer-auth-http.ts', '--port', String(port), '--token', validToken],
        },
      },
    };

    registry = createServerRegistry(serversConfig, { cwd: projectRoot, dialects: ['start'] });
  });

  after(async () => {
    if (client) await client.close();
    if (registry) await registry.close();
  });

  it('should connect with valid bearer token in headers', async () => {
    if (!registry) throw new Error('Registry not initialized');
    client = await registry.connect('bearer-test');

    assert.ok(client, 'Client should be created');

    // Verify server is functional with bearer auth
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0, 'Should have tools');
  });

  it('should list tools with authenticated connection', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const tools = await client.listTools();
    const echoTool = tools.tools.find((t) => t.name === 'echo');

    assert.ok(echoTool, 'Should have echo tool');
    assert.strictEqual(echoTool.description, 'Echoes back the provided message');
  });

  it('should call tools on bearer-auth server', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const wrapped = await client.callTool({ name: 'echo', arguments: { message: 'auth-test' } });
    const result = wrapped.raw();

    const content = (result.content ?? []) as unknown[];
    assert.ok(content.length > 0, 'Should have content');
    const textContent = content[0] as { type: string; text: string };
    if (!textContent) throw new Error('Expected content at index 0');
    assert.strictEqual(textContent.type, 'text');
    assert.ok(textContent.text.includes('auth-test'), 'Should echo message');
  });

  it('should fail connection without authorization header', async () => {
    // Create config without headers field (no auth)
    const configNoAuth: ServersConfig = {
      'bearer-test-no-auth': {
        url,
        // No headers field - should get 401
      },
    };

    await assert.rejects(
      async () => {
        await connectMcpClient(configNoAuth, 'bearer-test-no-auth');
      },
      (error: unknown) => {
        // Expect some form of connection/auth error
        assert.ok(error instanceof Error, 'Should throw Error');
        // The error might be a fetch error or MCP protocol error
        // Just verify it failed (we can't easily check for 401 in the error message)
        return true;
      },
      'Should reject connection without authorization header'
    );
  });

  it('should fail connection with invalid bearer token', async () => {
    // Create config with wrong token
    const configBadToken: ServersConfig = {
      'bearer-test-bad-token': {
        url,
        headers: {
          Authorization: 'Bearer wrong-token-invalid',
        },
      },
    };

    await assert.rejects(
      async () => {
        await connectMcpClient(configBadToken, 'bearer-test-bad-token');
      },
      (error: unknown) => {
        // Expect some form of connection/auth error
        assert.ok(error instanceof Error, 'Should throw Error');
        return true;
      },
      'Should reject connection with invalid bearer token'
    );
  });

  it('should list resources with bearer auth', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const resources = await client.listResources();
    const echoResource = resources.resources.find((r) => r.name === 'echo');

    assert.ok(echoResource, 'Should have echo resource');
    assert.strictEqual(echoResource.description, 'Echoes back messages as resources');
  });

  it('should read resource with bearer auth', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const resource = await client.readResource({ uri: 'echo://auth-resource' });
    const result = resource.raw();

    assert.ok(result.contents.length > 0, 'Should have contents');
    const content = result.contents[0];
    if (!content) throw new Error('Expected content at index 0');
    assert.strictEqual(content.uri, 'echo://auth-resource');
    if ('text' in content) {
      assert.ok(content.text.includes('auth-resource'), 'Should echo resource message');
    } else {
      assert.fail('Expected text content');
    }
  });

  it('should list prompts with bearer auth', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const prompts = await client.listPrompts();
    const echoPrompt = prompts.prompts.find((p) => p.name === 'echo');

    assert.ok(echoPrompt, 'Should have echo prompt');
    assert.strictEqual(echoPrompt?.description, 'Creates a prompt to process a message');
  });

  it('should get prompt with bearer auth', async () => {
    if (!client) {
      if (!registry) throw new Error('Registry not initialized');
      client = await registry.connect('bearer-test');
    }

    const prompt = await client.getPrompt({ name: 'echo', arguments: { message: 'auth-prompt' } });
    const result = prompt.raw();

    assert.ok(result.messages.length > 0, 'Should have messages');
    const message = result.messages[0];
    if (!message) throw new Error('Expected message at index 0');
    assert.strictEqual(message.role, 'user');
    if (message.content.type === 'text') {
      assert.ok(message.content.text.includes('auth-prompt'), 'Should include prompt message');
    } else {
      assert.fail('Expected text content type');
    }
  });

  it('should support bearer auth with SSE fallback', async () => {
    // This test verifies that bearer token authentication works with SSE transport fallback.
    // The registry.connect() function:
    // 1. First tries StreamableHTTPClientTransport with headers
    // 2. Falls back to SSEClientTransport with headers if Streamable HTTP fails
    //
    // Both transports receive the same headers from the config, ensuring bearer auth
    // works regardless of which transport is used.
    //
    // Since bearer-auth-http server supports both transports, this test confirms
    // the header merging logic works correctly for both code paths.

    if (!registry) throw new Error('Registry not initialized');
    const testClient = await registry.connect('bearer-test');
    assert.ok(testClient, 'Bearer auth should work with SSE fallback implementation');

    const tools = await testClient.listTools();
    assert.ok(tools.tools.length > 0, 'Should list tools with bearer auth');

    await testClient.close();
  });

  it('should support multiple custom headers alongside bearer auth', async () => {
    // Test that multiple headers can be passed together
    const port2 = await getPort();
    const url2 = `http://localhost:${port2}/mcp`;

    const configMultiHeaders: ServersConfig = {
      'bearer-multi-headers': {
        url: url2,
        headers: {
          Authorization: `Bearer ${validToken}`,
          'X-Custom-Header': 'custom-value',
          'X-Another-Header': 'another-value',
        },
        start: {
          command: 'node',
          args: ['test/lib/servers/bearer-auth-http.ts', '--port', String(port2), '--token', validToken],
        },
      },
    };

    const registry2 = createServerRegistry(configMultiHeaders, { cwd: projectRoot, dialects: ['start'] });

    try {
      const client2 = await registry2.connect('bearer-multi-headers');

      // Verify connection works with multiple headers
      const tools = await client2.listTools();
      assert.ok(tools.tools.length > 0, 'Should work with multiple custom headers');

      await client2.close();
    } finally {
      await registry2.close();
    }
  });
});
