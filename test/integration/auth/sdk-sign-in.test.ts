/**
 * Sign-in through the SDK's auth(): client metadata documents (CIMD), dynamic registration (DCR), and the stored sign-ins of earlier releases.
 *
 * Everything runs against `test/lib/servers/oauth-server.mjs`: a real HTTP authorization server and a bearer-protected MCP endpoint on
 * 127.0.0.1. The server accepts the metadata URL as a client_id from a copy of the document's contents, so nothing fetches the live document.
 * Headless mode prints the authorization URL; the spec follows it, so the redirect reaches the loopback listener as a consent click would.
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import assert from 'assert';
import getPort from 'get-port';
import Keyv from 'keyv';
import { probeAuthCapabilities } from '../../../src/auth/index.ts';
import type { TokenSet } from '../../../src/auth/types.ts';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import { DcrAuthenticator, DynamicClientRegistrar } from '../../../src/dcr/index.ts';
import { startOAuthServer } from '../../lib/servers/oauth-server.mjs';
import waitFor from '../../lib/wait-for.ts';

// The application's own document, as its owner hosts it: a loopback URI without a port. The caller passes the URL as `clientMetadataUrl`.
const CLIENT_METADATA_URL = 'https://client.example.org/oauth/mcp-z-client.json';
const CLIENT_DOCUMENT = { redirect_uris: ['http://127.0.0.1/callback'] };
const CIMD = { url: CLIENT_METADATA_URL, document: CLIENT_DOCUMENT };

type Server = Awaited<ReturnType<typeof startOAuthServer>>;

/** A logger that follows every printed authorization URL, giving consent. */
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

async function withServer(config: Parameters<typeof startOAuthServer>[0], run: (server: Server) => Promise<void>): Promise<void> {
  const server = await startOAuthServer(config);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function entries(store: Keyv): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for await (const [key, value] of store.iterator()) out[String(key)] = value;
  return out;
}

async function connect(server: Server, store: Keyv, clientMetadataUrl?: string) {
  const logger = consentLogger(server.base);
  return connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger, dcrAuthenticator: { tokenStore: store, headless: true, logger, ...(clientMetadataUrl && { clientMetadataUrl }) } });
}

describe('integration/auth/sdk-sign-in', () => {
  const clientIds = (server: Server) => [...server.calls.authorize, ...server.calls.token].map((call) => call.client_id);

  describe('without clientMetadataUrl: the client never offers a metadata document', () => {
    it('signs in by registration on a server that offers only DCR', async () => {
      await withServer({ dcr: true }, async (server) => {
        const client = await connect(server, new Keyv());
        await client.close();

        assert.strictEqual(server.calls.register, 1);
        assert.ok(!clientIds(server).includes(CLIENT_METADATA_URL));
      });
    });

    it('signs in by registration on a server that offers both', async () => {
      await withServer({ dcr: true, cimd: CIMD }, async (server) => {
        const client = await connect(server, new Keyv());
        await client.close();

        assert.strictEqual(server.calls.register, 1);
        assert.ok(!clientIds(server).includes(CLIENT_METADATA_URL));
      });
    });

    it('fails with the SDK error on a server that offers only CIMD, registering nothing', async () => {
      await withServer({ cimd: CIMD }, async (server) => {
        await assert.rejects(connect(server, new Keyv()), /does not support dynamic client registration/);

        assert.strictEqual(server.calls.register, 0);
        assert.strictEqual(server.calls.authorize.length, 0);
      });
    });
  });

  describe('with clientMetadataUrl: the SDK chooses', () => {
    it('signs in with the URL as client_id on a server that offers only CIMD, and never registers', async () => {
      await withServer({ cimd: CIMD }, async (server) => {
        const client = await connect(server, new Keyv(), CLIENT_METADATA_URL);
        try {
          const tools = await client.listTools();
          assert.deepStrictEqual(
            tools.tools.map((tool) => tool.name),
            ['ping']
          );
        } finally {
          await client.close();
        }

        assert.strictEqual(server.calls.register, 0, 'no registration request');
        assert.deepStrictEqual(
          server.calls.authorize.map((call) => call.client_id),
          [CLIENT_METADATA_URL]
        );
        assert.deepStrictEqual(
          server.calls.token.map((call) => call.client_id),
          [CLIENT_METADATA_URL]
        );
      });
    });

    it('stores no client secret', async () => {
      await withServer({ cimd: CIMD }, async (server) => {
        const store = new Keyv();
        const client = await connect(server, store, CLIENT_METADATA_URL);
        await client.close();

        const stored = JSON.stringify(await entries(store));
        assert.ok(stored.includes('access_'), 'the sign-in itself was stored');
        assert.ok(!/client_?[Ss]ecret/.test(stored), stored);
      });
    });

    it('chooses the metadata document on a server that offers both, and does not register', async () => {
      await withServer({ dcr: true, cimd: CIMD }, async (server) => {
        const client = await connect(server, new Keyv(), CLIENT_METADATA_URL);
        await client.close();

        assert.strictEqual(server.calls.register, 0);
        assert.strictEqual(server.calls.authorize[0]?.client_id, CLIENT_METADATA_URL);
      });
    });

    it('registers on a server that offers only DCR', async () => {
      await withServer({ dcr: true }, async (server) => {
        const client = await connect(server, new Keyv(), CLIENT_METADATA_URL);
        await client.close();

        assert.strictEqual(server.calls.register, 1);
        assert.ok(!clientIds(server).includes(CLIENT_METADATA_URL));
      });
    });

    it('reports the document as supported in the discovered capabilities', async () => {
      await withServer({ dcr: true, cimd: CIMD }, async (server) => {
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        assert.strictEqual(capabilities.supportsCimd, true);
        assert.strictEqual(capabilities.supportsDcr, true);
      });
    });
  });

  describe('callback', () => {
    it('is on the 127.0.0.1 loopback address', async () => {
      await withServer({ dcr: true }, async (server) => {
        const client = await connect(server, new Keyv());
        await client.close();

        const redirect = new URL(String(server.calls.authorize[0]?.redirect_uri));
        assert.strictEqual(redirect.protocol, 'http:');
        assert.strictEqual(redirect.hostname, '127.0.0.1');
        assert.strictEqual(redirect.pathname, '/callback');
      });
    });
  });

  describe('a client the server no longer knows', () => {
    it('registers again when a refresh answers invalid_client', async () => {
      await withServer({ dcr: true }, async (server) => {
        const store = new Keyv();
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, store);

        const first = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
        assert.strictEqual(server.calls.register, 1);

        await expire(store);
        server.forgetClients();
        const second = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

        assert.strictEqual(server.calls.register, 2, 'registered a new client');
        assert.strictEqual(server.calls.authorize.length, 2);
        assert.notStrictEqual(second.accessToken, first.accessToken);
      });
    });
  });

  describe('sign-ins stored by earlier releases', () => {
    it('refreshes a stored sign-in with the client it was registered with, without registering or asking again', async () => {
      await withServer({ dcr: true }, async (server) => {
        const store = new Keyv();
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, store);
        const first = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
        const key = tokenKey(capabilities.issuer, server.mcpUrl);

        // What an earlier release left: the token entry alone, carrying its client credentials.
        const stored = (await store.get(key)) as TokenSet;
        await store.clear();
        await store.set(key, { ...stored, expiresAt: Date.now() - 1000 });

        const refreshed = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

        assert.strictEqual(server.calls.register, 1, 'the stored registration was reused');
        assert.strictEqual(server.calls.authorize.length, 1, 'no new consent');
        assert.strictEqual(server.calls.token.at(-1)?.grant_type, 'refresh_token');
        assert.strictEqual(server.calls.token.at(-1)?.client_id, stored.clientId);
        assert.notStrictEqual(refreshed.accessToken, first.accessToken);

        const after = (await store.get(key)) as TokenSet;
        assert.strictEqual(after.accessToken, refreshed.accessToken, 'saved under the same key, in the same shape');
        assert.strictEqual(after.clientId, stored.clientId);
        assert.strictEqual(after.issuer, capabilities.issuer);
      });
    });

    it('uses a sign-in stored in the dcr-tokens family and saves its refresh under tokens', async () => {
      await withServer({ dcr: true }, async (server) => {
        const store = new Keyv();
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, store);
        await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
        const key = tokenKey(capabilities.issuer, server.mcpUrl);
        const stored = (await store.get(key)) as TokenSet;
        await store.clear();
        await store.set(key.replace(/^tokens:/, 'dcr-tokens:'), { ...stored, expiresAt: Date.now() - 1000 });

        const refreshed = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

        assert.strictEqual(server.calls.register, 1);
        assert.strictEqual(server.calls.authorize.length, 1);
        assert.strictEqual(((await store.get(key)) as TokenSet).accessToken, refreshed.accessToken);
      });
    });

    it('signs in again, with a new registration, when the stored sign-in has no refresh token and has expired', async () => {
      await withServer({ dcr: true }, async (server) => {
        const store = new Keyv();
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, store);
        await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
        const key = tokenKey(capabilities.issuer, server.mcpUrl);
        const stored = (await store.get(key)) as TokenSet;
        await store.clear();
        await store.set(key, { ...stored, refreshToken: '', expiresAt: Date.now() - 1000 });

        await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

        assert.strictEqual(server.calls.register, 2);
        assert.strictEqual(server.calls.authorize.length, 2);
      });
    });
  });
});

describe('integration/auth/sdk-sign-in: a server that has lost the stored token', () => {
  for (const transport of ['streamable', 'sse'] as const) {
    it(`drops it and signs in again (${transport} transport)`, async () => {
      await withServer({ dcr: true, sse: transport === 'sse' }, async (server) => {
        const store = new Keyv();
        const first = await connect(server, store);
        await first.close();
        const before = JSON.stringify(await entries(store));
        server.revokeAll();

        const second = await connect(server, store);
        try {
          const tools = await second.listTools();
          assert.deepStrictEqual(
            tools.tools.map((tool) => tool.name),
            ['ping']
          );
        } finally {
          await second.close();
        }

        assert.strictEqual(server.calls.authorize.length, 2, 'asked the user again');
        assert.notStrictEqual(JSON.stringify(await entries(store)), before, 'the new sign-in replaced the lost one');
      });
    });
  }
});

describe('integration/auth/sdk-sign-in: a stored token is kept when the server cannot be asked', () => {
  /** A signed-in store whose token has expired, so the next call must refresh it. */
  async function expiredSignIn(server: Server) {
    const store = new Keyv();
    const capabilities = await probeAuthCapabilities(server.mcpUrl);
    const authenticator = await newAuthenticator(server, store);
    await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
    await expire(store);
    const key = tokenKey(capabilities.issuer, server.mcpUrl);
    return { store, capabilities, authenticator, key, kept: (await store.get(key)) as TokenSet };
  }

  it('after a refused connection', async () => {
    await withServer({ dcr: true }, async (server) => {
      const { store, capabilities, authenticator, key, kept } = await expiredSignIn(server);
      await server.close();

      await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), (error: Error) => {
        assert.ok(!/Authorization timeout/.test(error.message), 'reports the network failure instead of waiting for a sign-in nobody can complete');
        return true;
      });

      assert.deepStrictEqual(await store.get(key), kept);
    });
  });

  it('after the request is aborted in flight', async () => {
    await withServer({ dcr: true }, async (server) => {
      const { store, capabilities, authenticator, key, kept } = await expiredSignIn(server);
      server.hangTokens(true);
      const controller = new AbortController();
      const reason = new Error('cancelled');

      const pending = authenticator.ensureAuthenticated(server.mcpUrl, capabilities, controller.signal);
      pending.catch(() => {});
      await waitFor('the refresh request to reach the server', () => (server.calls.token.some((call) => call.hung) ? true : undefined));
      controller.abort(reason);

      await assert.rejects(pending, (error: unknown) => error === reason);
      assert.deepStrictEqual(await store.get(key), kept);
    });
  });
});

/** A logger that gives consent to every printed authorization URL and keeps what it was told. */
function watchedLogger(base: string) {
  const authorizeUrls: string[] = [];
  const debug: string[] = [];
  const noop = () => {};
  return {
    authorizeUrls,
    debug,
    logger: {
      debug: (message: unknown) => {
        debug.push(String(message));
      },
      warn: noop,
      error: noop,
      info: (message: unknown) => {
        if (typeof message === 'string' && message.startsWith(`${base}/authorize`)) {
          authorizeUrls.push(message);
          void fetch(message).catch(() => {});
        }
      },
    },
  };
}

function connectWatched(server: Server, store: Keyv, logger: ReturnType<typeof watchedLogger>['logger']) {
  return connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger, dcrAuthenticator: { tokenStore: store, headless: true, logger } });
}

describe('integration/auth/sdk-sign-in: a 401 after connect', () => {
  it('fails with UnauthorizedError and starts no sign-in, for one request and for concurrent ones', async () => {
    await withServer({ dcr: true }, async (server) => {
      const watch = watchedLogger(server.base);
      const client = await connectWatched(server, new Keyv(), watch.logger);
      try {
        const urlsBefore = watch.authorizeUrls.length;
        const listenersBefore = watch.debug.filter((message) => message.includes('Callback server listening')).length;
        server.revokeAll();

        const results = await Promise.allSettled([client.listTools(), client.listTools(), client.listTools()]);

        for (const result of results) {
          assert.strictEqual(result.status, 'rejected');
          assert.ok(UnauthorizedError.isInstance((result as PromiseRejectedResult).reason), String((result as PromiseRejectedResult).reason));
        }
        assert.strictEqual(watch.authorizeUrls.length, urlsBefore, 'no authorization URL was shown');
        assert.strictEqual(watch.debug.filter((message) => message.includes('Callback server listening')).length, listenersBefore, 'no callback listener was started');
        assert.strictEqual(server.calls.authorize.length, 1);
      } finally {
        await client.close();
      }
    });
  });
});

describe('integration/auth/sdk-sign-in: failures that are not an answer about the credentials', () => {
  async function expiredSignInWatched(server: Server) {
    const watch = watchedLogger(server.base);
    const store = new Keyv();
    const capabilities = await probeAuthCapabilities(server.mcpUrl);
    const { default: getPort } = await import('get-port');
    const port = await getPort({ host: '127.0.0.1' });
    const authenticator = new DcrAuthenticator({ tokenStore: store, headless: true, redirectUri: `http://127.0.0.1:${port}/callback`, logger: watch.logger });
    await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
    await expire(store);
    const key = tokenKey(capabilities.issuer, server.mcpUrl);
    return { watch, store, capabilities, authenticator, key, kept: (await store.get(key)) as TokenSet };
  }

  it('a 5xx on refresh keeps the token and starts no sign-in', async () => {
    await withServer({ dcr: true }, async (server) => {
      const { watch, store, capabilities, authenticator, key, kept } = await expiredSignInWatched(server);
      const urlsBefore = watch.authorizeUrls.length;
      server.failTokens(503, 'refresh_token');

      await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), (error: Error) => {
        assert.ok(!/Authorization timeout/.test(error.message), error.message);
        return true;
      });

      assert.strictEqual(watch.authorizeUrls.length, urlsBefore);
      assert.deepStrictEqual(await store.get(key), kept);
    });
  });

  it('a 5xx at the token exchange keeps what was stored and starts nothing further', async () => {
    await withServer({ dcr: true }, async (server) => {
      const store = new Keyv();
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const authenticator = await newAuthenticator(server, store);
      server.failTokens(503, 'authorization_code');

      await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities));

      const keys = Object.keys(await entries(store));
      assert.deepStrictEqual(keys, [`client:${capabilities.issuer}:${server.mcpUrl}`], 'the registration is kept, no tokens were invented');
      assert.strictEqual(server.calls.register, 1);
    });
  });

  it('through the transport 401 hook: a 5xx on refresh keeps the token and starts no sign-in', async () => {
    await withServer({ dcr: true }, async (server) => {
      const watch = watchedLogger(server.base);
      const store = new Keyv();
      const client = await connectWatched(server, store, watch.logger);
      try {
        const urlsBefore = watch.authorizeUrls.length;
        const kept = JSON.stringify(await entries(store));
        server.revokeAccessTokens();
        server.failTokens(503, 'refresh_token');

        await assert.rejects(client.listTools());

        assert.strictEqual(watch.authorizeUrls.length, urlsBefore);
        assert.strictEqual(JSON.stringify(await entries(store)), kept);
      } finally {
        await client.close();
      }
    });
  });
});

describe('integration/auth/sdk-sign-in: a failed sign-in on Streamable HTTP', () => {
  it('does not fall back to SSE and does not open a second sign-in', async () => {
    await withServer({ dcr: true }, async (server) => {
      const watch = watchedLogger(server.base);
      const store = new Keyv();
      const first = await connectWatched(server, store, watch.logger);
      await first.close();
      server.revokeAll();
      server.corruptState('wrong');

      await assert.rejects(connectWatched(server, store, watch.logger), /state mismatch/);

      assert.strictEqual(server.calls.authorize.length, 2, 'one sign-in for the first connect, one for the failed attempt, none for a fallback');
    });
  });
});

describe('integration/auth/sdk-sign-in: what is refused before any code is redeemed', () => {
  for (const mode of ['wrong', 'missing'] as const) {
    it(`an authorization response with a ${mode} state`, async () => {
      await withServer({ dcr: true, state: mode }, async (server) => {
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, new Keyv());

        await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), /state mismatch/);

        assert.ok(!server.calls.token.some((call) => call.grant_type === 'authorization_code'), 'the code was not redeemed');
      });
    });
  }

  it('a protected-resource document whose resource does not cover the server URL', async () => {
    await withServer({ dcr: true, resource: 'http://other.example/mcp' }, async (server) => {
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const authenticator = await newAuthenticator(server, new Keyv());

      await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), /resource/i);

      assert.strictEqual(server.calls.authorize.length, 0);
      assert.strictEqual(server.calls.register, 0);
    });
  });
});

describe('integration/auth/sdk-sign-in: a sign-in stored by 2.5.x against a server that takes client_secret_post only', () => {
  it('refreshes with the secret in the body and does not register again', async () => {
    await withServer({ dcr: true, clientAuth: 'post' }, async (server) => {
      const store = new Keyv();
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const registration = await fetch(`${server.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/callback'] }) });
      const client = (await registration.json()) as { client_id: string; client_secret: string };
      const issued = server.issueTokens(client.client_id);
      const key = tokenKey(capabilities.issuer, server.mcpUrl);
      await store.set(key, { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresAt: Date.now() - 1000, clientId: client.client_id, clientSecret: client.client_secret, issuer: capabilities.issuer } satisfies TokenSet);
      const registered = server.calls.register;
      const authenticator = await newAuthenticator(server, store);

      const refreshed = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

      assert.strictEqual(server.calls.register, registered, 'no new registration');
      assert.strictEqual(server.calls.authorize.length, 0, 'no new consent');
      assert.strictEqual(server.calls.token.at(-1)?.grant_type, 'refresh_token');
      assert.notStrictEqual(refreshed.accessToken, issued.accessToken);
    });
  });
});

describe('integration/auth/sdk-sign-in: a server that offers registration but no authorization or token endpoint', () => {
  it('is refused with the endpoints error instead of being connected to without a token', async () => {
    await withServer({ dcr: true, noEndpoints: true }, async (server) => {
      await assert.rejects(connect(server, new Keyv()), /Server does not provide required OAuth endpoints/);
    });
  });
});

describe('integration/auth/sdk-sign-in: the client name', () => {
  it('is left out of the registration when the application sets none', async () => {
    await withServer({ dcr: true }, async (server) => {
      const authenticator = await newAuthenticator(server, new Keyv());
      await authenticator.ensureAuthenticated(server.mcpUrl, await probeAuthCapabilities(server.mcpUrl));

      assert.strictEqual(server.calls.registrations.length, 1);
      assert.ok(!('client_name' in (server.calls.registrations[0] ?? {})), JSON.stringify(server.calls.registrations[0]));
    });
  });

  it("is the application's value when it sets one", async () => {
    await withServer({ dcr: true }, async (server) => {
      const port = await getPort({ host: '127.0.0.1' });
      const authenticator = new DcrAuthenticator({ tokenStore: new Keyv(), headless: true, redirectUri: `http://127.0.0.1:${port}/callback`, logger: consentLogger(server.base), clientName: 'My Application' });
      await authenticator.ensureAuthenticated(server.mcpUrl, await probeAuthCapabilities(server.mcpUrl));

      assert.strictEqual(server.calls.registrations[0]?.client_name, 'My Application');
    });
  });

  it('is left out by DynamicClientRegistrar too, and sent when given', async () => {
    await withServer({ dcr: true }, async (server) => {
      const registrar = new DynamicClientRegistrar();
      await registrar.registerClient(`${server.base}/register`, { redirectUri: 'http://127.0.0.1:1/callback', allowLoopback: true });
      await registrar.registerClient(`${server.base}/register`, { redirectUri: 'http://127.0.0.1:1/callback', allowLoopback: true, clientName: 'My Application' });

      assert.ok(!('client_name' in (server.calls.registrations[0] ?? {})));
      assert.strictEqual(server.calls.registrations[1]?.client_name, 'My Application');
    });
  });
});

describe('integration/auth/sdk-sign-in: an authorization server that names another issuer than the one it was fetched from (RFC 8414 section 3.3)', () => {
  it('is refused in discovery', async () => {
    await withServer({ dcr: true, issuer: 'https://evil.example' }, async (server) => {
      await assert.rejects(probeAuthCapabilities(server.mcpUrl), /issuer/i);
    });
  });

  it('is refused before anything is registered, asked or sent', async () => {
    await withServer({ dcr: true, issuer: 'https://evil.example' }, async (server) => {
      await assert.rejects(connect(server, new Keyv()), /issuer/i);

      assert.strictEqual(server.calls.register, 0);
      assert.strictEqual(server.calls.authorize.length, 0);
      assert.strictEqual(server.calls.token.length, 0);
    });
  });
});

describe('integration/auth/sdk-sign-in: a token endpoint that redirects', () => {
  it('is not followed with the refresh token and client secret', async () => {
    await withServer({ dcr: true }, async (server) => {
      const store = new Keyv();
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const authenticator = await newAuthenticator(server, store);
      await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);
      await expire(store);
      const key = tokenKey(capabilities.issuer, server.mcpUrl);
      const stored = (await store.get(key)) as TokenSet;

      // A second server on 127.0.0.1 that records whatever reaches it.
      const received: string[] = [];
      const other = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          received.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''} ${body}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      try {
        server.redirectTokens(`http://127.0.0.1:${(other.address() as AddressInfo).port}/capture`);

        await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), (error: Error) => {
          assert.ok(!error.message.includes(stored.refreshToken) && !error.message.includes(String(stored.clientSecret)), 'the error names no secret');
          return true;
        });

        assert.deepStrictEqual(received, [], 'the redirect target received nothing');
        assert.deepStrictEqual(await store.get(key), stored, 'the stored sign-in is kept');
      } finally {
        other.closeAllConnections();
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    });
  });
});

describe('integration/auth/sdk-sign-in: a token response without expires_in', () => {
  it('is stored with an unknown expiry, used without a refresh, and refreshed once when the server answers 401', async () => {
    await withServer({ dcr: true, omitExpiresIn: true }, async (server) => {
      const store = new Keyv();
      const first = await connect(server, store);
      await first.close();
      const stored = Object.values(await entries(store)).find((value) => (value as TokenSet).accessToken) as TokenSet;
      assert.ok(!Number.isFinite(stored.expiresAt), `the expiry is unknown, not a guess: ${stored.expiresAt}`);

      const second = await connect(server, store);
      await second.close();
      assert.strictEqual(server.calls.token.length, 1, 'no refresh while nothing says the token is stale');

      server.revokeAccessTokens();
      const third = await connect(server, store);
      try {
        assert.strictEqual((await third.listTools()).tools.length, 1);
      } finally {
        await third.close();
      }
      assert.deepStrictEqual(
        server.calls.token.map((call) => call.grant_type),
        ['authorization_code', 'refresh_token']
      );
    });
  });

  it('reads a 2.5.x entry stored with a null expiry as unknown, not as expired', async () => {
    await withServer({ dcr: true }, async (server) => {
      const store = new Keyv();
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const registration = await fetch(`${server.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/callback'] }) });
      const client = (await registration.json()) as { client_id: string; client_secret: string };
      const issued = server.issueTokens(client.client_id);
      await store.set(tokenKey(capabilities.issuer, server.mcpUrl), { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresAt: null, clientId: client.client_id, clientSecret: client.client_secret, issuer: capabilities.issuer });
      const authenticator = await newAuthenticator(server, store);

      const tokens = await authenticator.ensureAuthenticated(server.mcpUrl, capabilities);

      assert.strictEqual(tokens.accessToken, issued.accessToken);
      assert.strictEqual(server.calls.token.length, 0, 'no refresh request');
    });
  });
});

describe('integration/auth/sdk-sign-in: a registration endpoint that redirects', () => {
  it('is not followed, and the redirect target receives nothing', async () => {
    await withServer({ dcr: true }, async (server) => {
      const received: string[] = [];
      const other = http.createServer((req, res) => {
        received.push(`${req.method} ${req.url}`);
        res.writeHead(200);
        res.end('{}');
      });
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      try {
        server.redirectRegister(`http://127.0.0.1:${(other.address() as AddressInfo).port}/capture`);
        const capabilities = await probeAuthCapabilities(server.mcpUrl);
        const authenticator = await newAuthenticator(server, new Keyv());

        await assert.rejects(authenticator.ensureAuthenticated(server.mcpUrl, capabilities), /redirect/i);

        assert.deepStrictEqual(received, []);
      } finally {
        other.closeAllConnections();
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    });
  });
});

describe('integration/auth/sdk-sign-in: the authorization server cannot be asked through the transport 401 hook', () => {
  async function signedIn(server: Server, signal?: AbortSignal) {
    const watch = watchedLogger(server.authBase);
    const store = new Keyv();
    const client = await connectMcpClient({ srv: { type: 'http', url: server.mcpUrl } }, 'srv', { logger: watch.logger, signal, dcrAuthenticator: { tokenStore: store, headless: true, logger: watch.logger } });
    return { watch, store, client, kept: JSON.stringify(await entries(store)), urlsBefore: watch.authorizeUrls.length };
  }

  it('keeps the sign-in when the connection is refused', async () => {
    await withServer({ dcr: true, separateAuthServer: true }, async (server) => {
      const { watch, store, client, kept, urlsBefore } = await signedIn(server);
      try {
        server.revokeAccessTokens();
        await server.closeAuthServer();

        await assert.rejects(client.listTools());

        assert.strictEqual(JSON.stringify(await entries(store)), kept);
        assert.strictEqual(watch.authorizeUrls.length, urlsBefore);
      } finally {
        await client.close();
      }
    });
  });

  it('keeps the sign-in when the request is aborted in flight', async () => {
    await withServer({ dcr: true, separateAuthServer: true }, async (server) => {
      const controller = new AbortController();
      const { watch, store, client, kept, urlsBefore } = await signedIn(server, controller.signal);
      try {
        server.revokeAccessTokens();
        server.hangTokens(true);
        const pending = client.listTools();
        pending.catch(() => {});
        await waitFor('the refresh request to reach the authorization server', () => (server.calls.token.some((call) => call.hung) ? true : undefined));
        controller.abort(new Error('cancelled'));

        await assert.rejects(pending);

        assert.strictEqual(JSON.stringify(await entries(store)), kept);
        assert.strictEqual(watch.authorizeUrls.length, urlsBefore);
      } finally {
        await client.close();
      }
    });
  });
});

describe('integration/auth/sdk-sign-in: a refresh refused with invalid_grant after connect', () => {
  it('registers no new client before failing with UnauthorizedError, for a sign-in stored by 2.5.x', async () => {
    await withServer({ dcr: true }, async (server) => {
      const store = new Keyv();
      const capabilities = await probeAuthCapabilities(server.mcpUrl);
      const registration = await fetch(`${server.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/callback'] }) });
      const registered = (await registration.json()) as { client_id: string; client_secret: string };
      const issued = server.issueTokens(registered.client_id);
      await store.set(tokenKey(capabilities.issuer, server.mcpUrl), { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresAt: Date.now() + 3600000, clientId: registered.client_id, clientSecret: registered.client_secret, issuer: capabilities.issuer } satisfies TokenSet);
      const client = await connect(server, store);
      try {
        server.revokeAll();

        await assert.rejects(client.listTools(), (error: unknown) => UnauthorizedError.isInstance(error));

        assert.strictEqual(server.calls.register, 1, 'only the registration this spec made');
      } finally {
        await client.close();
      }
    });
  });
});

function tokenKey(issuer: string | undefined, mcpUrl: string): string {
  return `tokens:${issuer}:${mcpUrl}`;
}

/** Marks every stored token set as expired, leaving everything else as it is. */
async function expire(store: Keyv): Promise<void> {
  for (const [key, value] of Object.entries(await entries(store))) {
    if (key.startsWith('tokens:')) await store.set(key, { ...(value as TokenSet), expiresAt: Date.now() - 1000 });
  }
}

/** An authenticator whose callback is on a free 127.0.0.1 port, as connectMcpClient builds it. */
async function newAuthenticator(server: Server, store: Keyv): Promise<DcrAuthenticator> {
  const port = await getPort({ host: '127.0.0.1' });
  return new DcrAuthenticator({ tokenStore: store, headless: true, redirectUri: `http://127.0.0.1:${port}/callback`, logger: consentLogger(server.base) });
}
