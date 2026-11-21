/**
 * The name and version the client sends to every server in `initialize`.
 *
 * Stdio: `test/lib/servers/client-info-stdio.mjs` returns what it received. HTTP: `test/lib/servers/oauth-server.mjs` records the clientInfo of each
 * authenticated `initialize` (Streamable HTTP, the SSE fallback, and the client made after a sign-in during connect).
 */

import '../../lib/env-loader.ts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerRegistry } from '@mcp-z/client';
import assert from 'assert';
import Keyv from 'keyv';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import type { ServersConfig } from '../../../src/spawn/spawn-servers.ts';
import { startOAuthServer } from '../../lib/servers/oauth-server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STDIO: ServersConfig = { srv: { command: 'node', args: [path.join(projectRoot, 'test/lib/servers/client-info-stdio.mjs')] } };

const CALLER = { name: 'my-application', version: '4.5.6' };
const TODAY = { name: 'mcp-cli-client', version: '1.0.0' };

async function stdioClientInfo(client: { callTool: (call: { name: string }) => Promise<unknown> }): Promise<unknown> {
  const result = (await client.callTool({ name: 'client-info' })) as { content: { text: string }[] };
  const { name, version } = JSON.parse(result.content[0]?.text ?? 'null');
  return { name, version };
}

function consentLogger(base: string) {
  const noop = () => {};
  return {
    debug: noop,
    warn: noop,
    error: noop,
    info: (message: unknown) => {
      if (typeof message === 'string' && message.startsWith(`${base}/authorize`)) void fetch(message).catch(() => {});
    },
  };
}

type Server = Awaited<ReturnType<typeof startOAuthServer>>;

async function withServer(config: Parameters<typeof startOAuthServer>[0], run: (server: Server) => Promise<void>): Promise<void> {
  const server = await startOAuthServer(config);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

const pick = (info: { name?: string; version?: string } | undefined) => ({ name: info?.name, version: info?.version });

describe('integration/connection/client-info', () => {
  describe('connectMcpClient', () => {
    it('sends the caller clientInfo to a stdio server', async () => {
      const client = await connectMcpClient(STDIO, 'srv', { clientInfo: CALLER });
      try {
        assert.deepStrictEqual(await stdioClientInfo(client), CALLER);
      } finally {
        await client.close();
      }
    });

    it('sends mcp-cli-client 1.0.0 to a stdio server when none is given', async () => {
      const client = await connectMcpClient(STDIO, 'srv');
      try {
        assert.deepStrictEqual(await stdioClientInfo(client), TODAY);
      } finally {
        await client.close();
      }
    });

    for (const [label, config, expectedCalls] of [
      ['Streamable HTTP', { dcr: true }, 1],
      ['the SSE fallback', { dcr: true, sse: true }, 1],
    ] as const) {
      it(`sends the caller clientInfo over ${label}`, async () => {
        await withServer(config, async (server) => {
          const logger = consentLogger(server.base);
          const client = await connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger, clientInfo: CALLER, dcrAuthenticator: { tokenStore: new Keyv(), headless: true, logger } });
          await client.close();

          assert.deepStrictEqual(server.calls.initialize.map(pick), Array(expectedCalls).fill(CALLER));
        });
      });

      it(`sends mcp-cli-client 1.0.0 over ${label} when none is given`, async () => {
        await withServer(config, async (server) => {
          const logger = consentLogger(server.base);
          const client = await connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger, dcrAuthenticator: { tokenStore: new Keyv(), headless: true, logger } });
          await client.close();

          assert.deepStrictEqual(server.calls.initialize.map(pick), Array(expectedCalls).fill(TODAY));
        });
      });
    }

    it('sends the caller clientInfo from the client made after a sign-in during connect', async () => {
      await withServer({ dcr: true }, async (server) => {
        const base = consentLogger(server.base);
        // The server forgets every token once the first sign-in is complete, so the first initialize is refused and a second client signs in again.
        const logger = {
          ...base,
          debug: (message: unknown) => {
            if (typeof message === 'string' && message.includes('Authentication complete')) server.revokeAll();
          },
        };
        const client = await connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger, clientInfo: CALLER, dcrAuthenticator: { tokenStore: new Keyv(), headless: true, logger } });
        await client.close();

        assert.strictEqual(server.calls.authorize.length, 2, 'signed in twice');
        assert.deepStrictEqual(server.calls.initialize.map(pick), [CALLER]);
      });
    });
  });

  describe('registry.connect', () => {
    it('sends the caller clientInfo to a stdio server, and mcp-cli-client 1.0.0 when none is given', async () => {
      const registry = createServerRegistry(STDIO, { dialects: ['servers'] });
      try {
        const given = await registry.connect('srv', { clientInfo: CALLER });
        assert.deepStrictEqual(await stdioClientInfo(given), CALLER);
        await given.close();

        const none = await registry.connect('srv');
        assert.deepStrictEqual(await stdioClientInfo(none), TODAY);
        await none.close();
      } finally {
        await registry.close();
      }
    });

    it('sends the caller clientInfo to an HTTP server, and mcp-cli-client 1.0.0 when none is given', async () => {
      await withServer({ dcr: true }, async (server) => {
        const logger = consentLogger(server.base);
        const registry = createServerRegistry({ srv: { type: 'http', url: server.mcpUrl } });
        try {
          const dcrAuthenticator = { tokenStore: new Keyv(), headless: true, logger };
          await (await registry.connect('srv', { logger, clientInfo: CALLER, dcrAuthenticator })).close();
          await (await registry.connect('srv', { logger, dcrAuthenticator })).close();

          assert.deepStrictEqual(server.calls.initialize.map(pick), [CALLER, TODAY]);
        } finally {
          await registry.close();
        }
      });
    });
  });
});

describe('integration/connection/client-info: the registry option and the full Implementation', () => {
  const OTHER = { name: 'per-connect-name', version: '7.8.9' };

  /** Everything the stdio server recorded from `initialize`. */
  async function recordedInfo(client: { callTool: (call: { name: string }) => Promise<unknown> }): Promise<Record<string, unknown>> {
    const result = (await client.callTool({ name: 'client-info' })) as { content: { text: string }[] };
    return JSON.parse(result.content[0]?.text ?? 'null');
  }

  async function lazilyConnected(registry: ReturnType<typeof createServerRegistry>) {
    await registry.searchCapabilities('client');
    const [managed] = [...registry.clients];
    assert.ok(managed, 'searchCapabilities connected the server');
    return managed.nativeClient;
  }

  it('is used by the connect that searchCapabilities makes', async () => {
    const registry = createServerRegistry(STDIO, { clientInfo: CALLER });
    try {
      const info = await recordedInfo(await lazilyConnected(registry));
      assert.deepStrictEqual({ name: info.name, version: info.version }, CALLER);
    } finally {
      await registry.close();
    }
  });

  it('leaves the legacy value in place for that connect when nothing is given', async () => {
    const registry = createServerRegistry(STDIO);
    try {
      const info = await recordedInfo(await lazilyConnected(registry));
      assert.deepStrictEqual({ name: info.name, version: info.version }, TODAY);
    } finally {
      await registry.close();
    }
  });

  it('is overridden by the clientInfo of a connect', async () => {
    const registry = createServerRegistry(STDIO, { clientInfo: CALLER });
    try {
      const client = await registry.connect('srv', { clientInfo: OTHER });
      const info = await recordedInfo(client.nativeClient);
      assert.deepStrictEqual({ name: info.name, version: info.version }, OTHER);
      await client.close();
    } finally {
      await registry.close();
    }
  });

  it('sends the fields of an Implementation beyond name and version, as given', async () => {
    const client = await connectMcpClient(STDIO, 'srv', { clientInfo: { ...CALLER, title: 'My Application', websiteUrl: 'https://app.example.org' } });
    try {
      const info = await recordedInfo(client);
      assert.strictEqual(info.title, 'My Application');
      assert.strictEqual(info.websiteUrl, 'https://app.example.org');
    } finally {
      await client.close();
    }
  });
});
