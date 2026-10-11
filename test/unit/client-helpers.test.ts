import '../lib/env-loader.ts';
import type { ManagedClient } from '@mcp-z/client';
import { createServerRegistry, decorateClient, PromptResponseError, ResourceResponseError, type ServerRegistry, ToolResponseError } from '@mcp-z/client';
import { Client, ProtocolError, SdkError } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CallToolResultSchema, GetPromptResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import assert from 'assert';

describe('ManagedClient helper overloads', () => {
  let registry: ServerRegistry | undefined;
  let client: ManagedClient;

  before(async () => {
    registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    client = await registry.connect('test-server');
  });

  after(async () => {
    if (registry) {
      await registry.close();
    }
  });

  it('exposes serverName metadata', () => {
    assert.strictEqual(client.serverName, 'test-server');
  });

  it('supports callTool(toolName, args)', async () => {
    const response = await client.callTool('ping', {});
    const result = response.json<{ result: string }>();
    assert.strictEqual(result.result, 'pong');
  });

  it('supports readResource(uri)', async () => {
    const result = await client.readResource('test://hello');
    const text = result.text();
    assert.ok(text.includes('Resource content'), 'content should include resource text');
  });

  it('supports getPrompt(name, args)', async () => {
    const prompt = await client.getPrompt('greet', { name: 'Tester' });
    const text = prompt.text();
    assert.ok(text.includes('Hello'), 'should include prompt text');
  });
});

describe('ManagedClient real SDK response contract', () => {
  let native: Client;
  let client: ManagedClient;
  let transport: StdioClientTransport;
  let originalMethods: [Client['callTool'], Client['getPrompt'], Client['readResource']];

  beforeEach(async () => {
    native = new Client({ name: 'helper-contract', version: '1.0.0' });
    originalMethods = [native.callTool, native.getPrompt, native.readResource];
    transport = new StdioClientTransport({ command: process.execPath, args: ['test/lib/servers/echo-stdio.mjs'] });
    await native.connect(transport);
    client = decorateClient(native, { serverName: 'echo' });
  });

  afterEach(async () => {
    await native.close();
    await transport.close();
  });

  it('preserves tool schema, binary content, metadata and serialized extensions with one invocation', async () => {
    const response = await client.callTool('echo', { message: 'complete', mode: 'rich' });
    const expected = { echo: 'Tool echo: complete' };
    assert.deepStrictEqual(response.structuredContent, expected);
    assert.deepStrictEqual(response.json(), expected);
    assert.deepStrictEqual(JSON.parse(response.text()), expected);
    assert.deepStrictEqual(
      response.content.map((block) => block.type),
      ['text', 'image', 'audio']
    );
    assert.deepStrictEqual(response.content[1], { type: 'image', data: 'AAEC', mimeType: 'image/png' });
    assert.deepStrictEqual(response.content[2], { type: 'audio', data: 'AwQF', mimeType: 'audio/wav' });
    assert.deepStrictEqual(response._meta, { invocations: 1, json: 'metadata extension' });
    const parsed = CallToolResultSchema.parse(response);
    assert.deepStrictEqual(parsed.content, response.content);
    assert.deepStrictEqual(parsed.structuredContent, expected);
    const serialized = JSON.parse(JSON.stringify(response));
    assert.deepStrictEqual(serialized, {
      content: response.content,
      structuredContent: expected,
      _meta: response._meta,
      json: 'server json extension',
      text: 'server text extension',
    });
    assert.ok(!('raw' in response));
    const next = await client.callTool({ name: 'echo', arguments: { message: 'next', mode: 'rich' } });
    assert.strictEqual(next._meta?.invocations, 2, 'representation and serialization must not invoke the tool');
  });

  it('preserves prompt roles and resource entries while keeping representation semantics', async () => {
    const prompt = await client.getPrompt('echo', { message: 'rich' });
    assert.strictEqual(prompt.description, 'Rich echo prompt');
    assert.deepStrictEqual(
      prompt.messages.map((message) => message.role),
      ['user', 'assistant', 'assistant']
    );
    assert.deepStrictEqual(prompt.messages[1]?.content, { type: 'image', data: 'AAEC', mimeType: 'image/png' });
    assert.strictEqual(prompt.text(), 'First message\n\nSecond message');
    assert.deepStrictEqual(GetPromptResultSchema.parse(prompt).messages, prompt.messages);
    assert.deepStrictEqual(prompt._meta, { fixture: 'echo-prompt' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(prompt)), {
      description: prompt.description,
      messages: prompt.messages,
      _meta: prompt._meta,
      text: 'prompt extension',
    });
    assert.throws(
      () => prompt.json(),
      (error: unknown) => error instanceof PromptResponseError && error.response.messages === prompt.messages
    );

    const resource = await client.readResource({ uri: 'echo://rich' });
    assert.deepStrictEqual(resource.contents, [
      { uri: 'echo://rich', blob: 'AAEC', mimeType: 'application/octet-stream' },
      { uri: 'echo://second', text: '{"second":true}', mimeType: 'application/json' },
    ]);
    assert.strictEqual(resource.text(), '\u0000\u0001\u0002');
    assert.deepStrictEqual(ReadResourceResultSchema.parse(resource).contents, resource.contents);
    assert.deepStrictEqual(resource._meta, { fixture: 'echo-resource' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(resource)), {
      contents: resource.contents,
      _meta: resource._meta,
      json: 'resource extension',
    });
    assert.throws(
      () => resource.json(),
      (error: unknown) => error instanceof ResourceResponseError && error.response.contents === resource.contents
    );
    assert.ok(!('raw' in prompt));
    assert.ok(!('raw' in resource));
  });

  it('rejects tool errors at await with the exported error and complete response', async () => {
    await assert.rejects(client.callTool({ name: 'echo', arguments: { message: 'invalid range', mode: 'error' } }), (error: unknown) => {
      assert.ok(error instanceof ToolResponseError);
      assert.strictEqual(error.response.isError, true);
      assert.deepStrictEqual(error.response.content, [{ type: 'text', text: 'Cannot echo: invalid range' }]);
      assert.deepStrictEqual(error.response.error, { message: 'Echo rejected: invalid range', code: 'ECHO_REJECTED' });
      assert.deepStrictEqual(error.response._meta, { invocations: 1 });
      assert.ok(error.message.includes('Echo rejected: invalid range'));
      return true;
    });
    const nativeResult = await native.callTool({ name: 'echo', arguments: { message: 'native', mode: 'error' } });
    assert.strictEqual(nativeResult.isError, true, 'the original SDK must retain its own error-result semantics');
    assert.strictEqual(nativeResult._meta?.invocations, 2);
  });

  it('propagates protocol rejections without turning them into tool response errors', async () => {
    await assert.rejects(client.getPrompt('missing-prompt'), (error: unknown) => error instanceof ProtocolError && !(error instanceof ToolResponseError));
  });

  it('forwards cancellation options for every operation and argument form', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };
    const calls = [
      () => client.callTool('echo', { message: 'cancelled' }, options),
      () => client.callTool({ name: 'echo', arguments: { message: 'cancelled' } }, options),
      () => client.getPrompt('echo', { message: 'cancelled' }, options),
      () => client.getPrompt({ name: 'echo', arguments: { message: 'cancelled' } }, options),
      () => client.readResource('echo://cancelled', options),
      () => client.readResource({ uri: 'echo://cancelled' }, options),
    ];
    for (const call of calls) {
      await assert.rejects(call(), (error: unknown) => error instanceof SdkError);
    }
    const result = await client.callTool('echo', { message: 'after cancellation', mode: 'rich' });
    assert.strictEqual(result._meta?.invocations, 1, 'pre-aborted calls must not invoke the tool');
  });

  it('keeps native identity, original methods and actual SDK receivers through the direct view', async () => {
    assert.strictEqual(client.nativeClient, native);
    assert.notStrictEqual(client, native);
    assert.ok(client instanceof Client);
    assert.strictEqual(client.constructor, Client);
    assert.strictEqual(Object.getPrototypeOf(client), Object.getPrototypeOf(native));
    assert.deepStrictEqual([native.callTool, native.getPrompt, native.readResource], originalMethods);
    assert.strictEqual(client.transport, native.transport);
    const listTools = client.listTools;
    assert.ok((await listTools()).tools.some((tool) => tool.name === 'echo'));
    let closes = 0;
    const onclose = () => {
      closes += 1;
    };
    client.onclose = onclose;
    assert.strictEqual(native.onclose, onclose);
    assert.strictEqual(client.onclose, onclose);
    assert.ok(!('callToolRaw' in client));
    assert.ok(!('getPromptRaw' in client));
    assert.ok(!('readResourceRaw' in client));
    await client.close();
    assert.strictEqual(closes, 1);
    assert.strictEqual(client.transport, undefined);
  });
});

describe('ManagedClient combined stdio lease', () => {
  it('shares native state and observes callbacks while releasing leases independently', async () => {
    const registry = createServerRegistry({ echo: { command: process.execPath, args: ['test/lib/servers/echo-stdio.mjs'] } });
    try {
      const first = await registry.connect('echo');
      const second = await registry.connect('echo');
      const native = first.nativeClient;
      assert.strictEqual(second.nativeClient, native);
      assert.notStrictEqual(first, native);
      assert.notStrictEqual(first, second);
      assert.strictEqual(first.transport, native.transport);
      assert.strictEqual(native.callTool, Client.prototype.callTool);
      const listTools = first.listTools;
      assert.ok((await listTools()).tools.some((tool) => tool.name === 'echo'));
      let closes = 0;
      const onclose = () => {
        closes += 1;
      };
      first.onclose = onclose;
      assert.strictEqual(native.onclose, onclose);
      assert.notStrictEqual(first.onclose, onclose, 'the outer lease binds function reads');
      await first.close();
      assert.strictEqual(closes, 0);
      assert.deepStrictEqual((await second.callTool('echo', { message: 'still connected' })).json(), { echo: 'Tool echo: still connected' });
      await second.close();
      assert.strictEqual(closes, 1);
      assert.strictEqual(native.transport, undefined);
    } finally {
      await registry.close();
    }
  });
});
