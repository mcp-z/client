// Protocol negotiation through real legacy and MCP SDK v2 stdio servers.

import '../../lib/env-loader.ts';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import type { ServersConfig } from '../../../src/spawn/spawn-servers.ts';

// Project root directory (avoid process.cwd() - brittle!)
const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '../../..');

const FIXTURES = {
  legacy: path.join(projectRoot, 'test/lib/servers/echo-stdio.mjs'),
  modern: path.join(projectRoot, 'test/lib/servers/modern-stdio.mjs'),
};

const config: ServersConfig = {
  legacy: { command: 'node', args: [FIXTURES.legacy], env: { NODE_ENV: 'test' } },
  modern: { command: 'node', args: [FIXTURES.modern] },
};

describe('connectMcpClient versionNegotiation', () => {
  it('should default to the plain 2025 connect sequence when the option is omitted', async () => {
    const client = await connectMcpClient(config, 'legacy');
    try {
      assert.strictEqual(client.getProtocolEra(), 'legacy');
    } finally {
      await client.close();
    }
  });

  it('should connect in legacy mode when explicitly requested', async () => {
    const client = await connectMcpClient(config, 'legacy', { versionNegotiation: { mode: 'legacy' } });
    try {
      assert.strictEqual(client.getProtocolEra(), 'legacy');
    } finally {
      await client.close();
    }
  });

  it('should probe and fall back to legacy on a 2025-era server', async () => {
    const client = await connectMcpClient(config, 'legacy', { versionNegotiation: { mode: 'auto' } });
    try {
      assert.strictEqual(client.getProtocolEra(), 'legacy');
    } finally {
      await client.close();
    }
  });

  it('should negotiate the modern revision on a 2026-era server', async () => {
    const client = await connectMcpClient(config, 'modern', { versionNegotiation: { mode: 'auto' } });
    try {
      assert.strictEqual(client.getProtocolEra(), 'modern');
      assert.strictEqual(client.getNegotiatedProtocolVersion(), '2026-07-28');
    } finally {
      await client.close();
    }
  });

  it('should connect pinned when the server offers the revision', async () => {
    const client = await connectMcpClient(config, 'modern', { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      assert.strictEqual(client.getProtocolEra(), 'modern');
      assert.strictEqual(client.getNegotiatedProtocolVersion(), '2026-07-28');
    } finally {
      await client.close();
    }
  });

  it('should call a tool on the negotiated modern server', async () => {
    const client = await connectMcpClient(config, 'modern', { versionNegotiation: { mode: 'auto' } });
    try {
      const result = await client.callTool({ name: 'echo', arguments: { message: 'round trip' } });
      const content = result.content?.[0];
      assert.ok(content && content.type === 'text');
      assert.strictEqual(content.text, 'Tool echo: round trip');
    } finally {
      await client.close();
    }
  });

  it('should fail with a typed era error when pinned against a 2025-era server', async () => {
    await assert.rejects(connectMcpClient(config, 'legacy', { versionNegotiation: { mode: { pin: '2026-07-28' } } }), (error: unknown) => {
      assert.ok(SdkError.isInstance(error), 'should throw the SDK SdkError');
      assert.strictEqual(error.code, SdkErrorCode.EraNegotiationFailed);
      return true;
    });
  });
});
