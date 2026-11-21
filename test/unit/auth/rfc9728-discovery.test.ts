/**
 * Unit tests for RFC 9728 Protected Resource Metadata discovery
 * Tests .well-known/oauth-protected-resource endpoint probing
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'assert';
import express from 'express';
import getPort from 'get-port';
import { DiscoveryFetchError, speculativeProbe } from '../../../src/auth/discovery-fetch.ts';
import { discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata } from '../../../src/auth/rfc9728-discovery.ts';
import { listenOnFreePort } from '../../lib/listen-on-free-port.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.mjs';

async function withHttpServer(handler: http.RequestListener, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function startPathPrefixedWellKnownServer(config: { host: string; prefix: string }) {
  const { host, prefix } = config;
  // Assigned once the server is listening; handlers only run after that.
  let baseUrl = '';
  const app = express();

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ['read', 'write'],
    });
  });

  app.get(`${prefix}/.well-known/oauth-protected-resource`, (_req, res) => {
    res.json({
      resource: `${baseUrl}${prefix}`,
      authorization_servers: [`${baseUrl}${prefix}`],
      scopes_supported: ['read', 'write'],
    });
  });

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ['read', 'write'],
    });
  });

  app.get(`${prefix}/.well-known/oauth-authorization-server`, (_req, res) => {
    res.json({
      issuer: `${baseUrl}${prefix}`,
      authorization_endpoint: `${baseUrl}${prefix}/oauth/authorize`,
      token_endpoint: `${baseUrl}${prefix}/oauth/token`,
      registration_endpoint: `${baseUrl}${prefix}/oauth/register`,
      scopes_supported: ['read', 'write'],
    });
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  baseUrl = `http://${host}:${await listenOnFreePort(server, host)}`;

  return {
    url: baseUrl,
    close: async () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('unit/auth/rfc9728-discovery', () => {
  let dcrServer: Awaited<ReturnType<typeof startDcrTestServer>>;

  before(async () => {
    dcrServer = await startDcrTestServer({
      port: 9997,
      baseUrl: 'http://localhost:9997',
    });
  });

  after(async () => {
    await dcrServer.close();
  });

  describe('discoverProtectedResourceMetadata', () => {
    it('should discover protected resource metadata from root location', async () => {
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997');

      assert.strictEqual(metadata?.resource, 'http://localhost:9997');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
      assert.deepStrictEqual(metadata?.scopes_supported, ['read', 'write']);
    });

    it('should discover metadata from MCP sub-path location', async () => {
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997/mcp');

      assert.strictEqual(metadata?.resource, 'http://localhost:9997/mcp');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
      assert.deepStrictEqual(metadata?.scopes_supported, ['read', 'write']);
    });

    it('should return null on network error (speculative probes)', async () => {
      assert.strictEqual(await discoverProtectedResourceMetadata('http://localhost:8887'), null);
    });

    it('should return null when the server offers no protected resource metadata (404)', async () => {
      await withHttpServer(
        (_req, res) => {
          res.writeHead(404).end();
        },
        async (base) => {
          assert.strictEqual(await discoverProtectedResourceMetadata(base), null);
        }
      );
    });

    it('should return null when every well-known path answers 200 HTML (single-page-app catch-all)', async () => {
      await withHttpServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>app</body></html>');
        },
        async (base) => {
          assert.strictEqual(await discoverProtectedResourceMetadata(`${base}/mcp`), null);
        }
      );
    });

    it('should return null when well-known paths redirect to a login page', async () => {
      await withHttpServer(
        (req, res) => {
          if (req.url === '/login') res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
          else res.writeHead(302, { location: '/login' }).end();
        },
        async (base) => {
          assert.strictEqual(await discoverProtectedResourceMetadata(`${base}/mcp`), null);
        }
      );
    });

    it('should return null when well-known paths redirect in a loop', async () => {
      await withHttpServer(
        (req, res) => {
          res.writeHead(302, { location: req.url ?? '/' }).end();
        },
        async (base) => {
          assert.strictEqual(await discoverProtectedResourceMetadata(base), null);
        }
      );
    });

    it('should return null when a well-known response is oversize', async () => {
      await withHttpServer(
        (req, res) => {
          if (req.url?.startsWith('/.well-known/oauth-protected-resource')) res.writeHead(200, { 'content-type': 'application/json' }).end(`{"pad":"${'x'.repeat(1_100_000)}"}`);
          else res.writeHead(404).end();
        },
        async (base) => {
          assert.strictEqual(await discoverProtectedResourceMetadata(base), null);
        }
      );
    });

    it('should fall back to the root metadata when the sub-path probe fails', async () => {
      await withHttpServer(
        (req, res) => {
          const origin = `http://${req.headers.host}`;
          if (req.url === '/.well-known/oauth-protected-resource') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: origin, authorization_servers: [origin] }));
          else if (req.url === '/.well-known/oauth-protected-resource/mcp') res.writeHead(200, { 'content-type': 'application/json' }).end('{broken');
          else res.writeHead(404).end();
        },
        async (base) => {
          const metadata = await discoverProtectedResourceMetadata(`${base}/mcp`);
          assert.strictEqual(metadata?.resource, base);
        }
      );
    });

    // A location the server advertised in WWW-Authenticate is not a guess: failures there reject.
    describe('advertised resource_metadata URL (strict)', () => {
      const advertise =
        (url: string): http.RequestListener =>
        (_req, res) => {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${url}"` }).end();
        };

      it('should reject when it points at a refused address (SSRF)', async () => {
        await withHttpServer(advertise('http://10.0.0.1/meta'), async (base) => {
          await assert.rejects(discoverProtectedResourceMetadata(base), /Refusing to fetch/);
        });
      });

      it('should reject when it is unreachable', async () => {
        await withHttpServer(advertise('http://127.0.0.1:1/meta'), async (base) => {
          await assert.rejects(discoverProtectedResourceMetadata(base), DiscoveryFetchError);
        });
      });

      for (const status of [404, 500]) {
        it(`should reject when it answers HTTP ${status}`, async () => {
          let base = '';
          const handler: http.RequestListener = (req, res) => {
            if (req.url === '/meta') res.writeHead(status).end();
            else advertise(`${base}/meta`)(req, res);
          };
          await withHttpServer(handler, async (b) => {
            base = b;
            await assert.rejects(discoverProtectedResourceMetadata(b), (error: unknown) => error instanceof DiscoveryFetchError && error.message.includes(String(status)));
          });
        });
      }

      it('should reject when it returns invalid JSON', async () => {
        let base = '';
        const handler: http.RequestListener = (req, res) => {
          if (req.url === '/meta') res.writeHead(200, { 'content-type': 'application/json' }).end('{broken');
          else advertise(`${base}/meta`)(req, res);
        };
        await withHttpServer(handler, async (b) => {
          base = b;
          await assert.rejects(discoverProtectedResourceMetadata(b), /invalid JSON/);
        });
      });

      it('should reject when it is oversize', async () => {
        let base = '';
        const handler: http.RequestListener = (req, res) => {
          if (req.url === '/meta') res.writeHead(200, { 'content-type': 'application/json' }).end(`{"pad":"${'x'.repeat(1_100_000)}"}`);
          else advertise(`${base}/meta`)(req, res);
        };
        await withHttpServer(handler, async (b) => {
          base = b;
          await assert.rejects(discoverProtectedResourceMetadata(b), /too large/);
        });
      });
    });

    it('should propagate an abort raised during a speculative probe', async () => {
      let requestSeen!: () => void;
      const seen = new Promise<void>((resolve) => (requestSeen = resolve));
      await withHttpServer(
        () => requestSeen(),
        async (base) => {
          const controller = new AbortController();
          const reason = new Error('cancelled');
          const pending = discoverProtectedResourceMetadata(base, { signal: controller.signal });
          await seen;
          controller.abort(reason);
          await assert.rejects(pending, (error: unknown) => error === reason);
        }
      );
    });

    it('should use root metadata for paths without specific metadata', async () => {
      // RFC 9728: Root metadata applies to all sub-paths unless overridden
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997/nonexistent');

      // Should return root metadata as it applies to all resources under this origin
      assert.strictEqual(metadata?.resource, 'http://localhost:9997');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
    });

    it('should return null on invalid URL', async () => {
      assert.strictEqual(await discoverProtectedResourceMetadata('not-a-url'), null);
    });

    it('should handle deep paths like /api/v1/mcp', async () => {
      // Even with deep paths, should check origin first, then sub-path
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997/api/v1/mcp');

      // Should find metadata at origin (returns resource: baseUrl)
      assert.strictEqual(metadata?.resource, 'http://localhost:9997');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
    });

    it('should follow resource_metadata from WWW-Authenticate header', async () => {
      const port = await getPort();
      const baseUrl = `http://localhost:${port}`;
      const server = await startDcrTestServer({
        port,
        baseUrl,
        wwwAuthenticateResourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      });

      try {
        const metadata = await discoverProtectedResourceMetadata(`${baseUrl}/mcp`);

        assert.strictEqual(metadata?.resource, `${baseUrl}/mcp`);
        assert.deepStrictEqual(metadata?.authorization_servers, [baseUrl]);
        assert.deepStrictEqual(metadata?.scopes_supported, ['read', 'write']);
      } finally {
        await server.close();
      }
    });

    it('should prefer path-local well-known for prefixed deployments', async () => {
      const server = await startPathPrefixedWellKnownServer({
        host: '127.0.0.1',
        prefix: '/outlook',
      });
      const baseUrl = server.url;

      try {
        const metadata = await discoverProtectedResourceMetadata(`${baseUrl}/outlook`);

        assert.strictEqual(metadata?.resource, `${baseUrl}/outlook`);
        assert.deepStrictEqual(metadata?.authorization_servers, [`${baseUrl}/outlook`]);
      } finally {
        await server.close();
      }
    });

    it('should ignore query and fragment when probing path-local well-known', async () => {
      const server = await startPathPrefixedWellKnownServer({
        host: '127.0.0.1',
        prefix: '/outlook',
      });
      const baseUrl = server.url;

      try {
        const metadata = await discoverProtectedResourceMetadata(`${baseUrl}/outlook?foo=bar#baz`);

        assert.strictEqual(metadata?.resource, `${baseUrl}/outlook`);
        assert.deepStrictEqual(metadata?.authorization_servers, [`${baseUrl}/outlook`]);
      } finally {
        await server.close();
      }
    });
  });

  describe('discoverAuthorizationServerMetadata', () => {
    // These calls provide a loopback URL directly (the caller *is* the
    // server it wants metadata from), so they pass { allowLoopback: true } -
    // the same grant capability-discovery.ts computes automatically from its
    // own baseUrl. See discovery-fetch.test.ts for the SSRF-relevant case:
    // an untrusted caller must NOT get this for free just because the target
    // happens to be loopback.
    it('should discover authorization server metadata from .well-known endpoint', async () => {
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:9997', { allowLoopback: true });

      assert.strictEqual(metadata?.issuer, 'http://localhost:9997');
      assert.strictEqual(metadata?.authorization_endpoint, 'http://localhost:9997/oauth/authorize');
      assert.strictEqual(metadata?.token_endpoint, 'http://localhost:9997/oauth/token');
      assert.strictEqual(metadata?.registration_endpoint, 'http://localhost:9997/oauth/register');
      assert.deepStrictEqual(metadata?.scopes_supported, ['read', 'write']);
    });

    it('should extract origin from URLs with paths', async () => {
      // Should check origin even if given a URL with path
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:9997/some/path', { allowLoopback: true });

      assert.strictEqual(metadata?.issuer, 'http://localhost:9997');
      assert.strictEqual(metadata?.authorization_endpoint, 'http://localhost:9997/oauth/authorize');
    });

    it('should reject on network error for an advertised authorization server', async () => {
      await assert.rejects(discoverAuthorizationServerMetadata('http://localhost:8886', { allowLoopback: true }), DiscoveryFetchError);
    });

    it('should return null on network error for a speculative probe', async () => {
      assert.strictEqual(await speculativeProbe(undefined, () => discoverAuthorizationServerMetadata('http://localhost:8886', { allowLoopback: true })), null);
    });

    it('should return null on 404 response', async () => {
      await withHttpServer(
        (_req, res) => {
          res.writeHead(404).end();
        },
        async (base) => {
          assert.strictEqual(await discoverAuthorizationServerMetadata(base, { allowLoopback: true }), null);
        }
      );
    });

    it('should reject invalid JSON from an advertised authorization server, but not from a speculative probe', async () => {
      await withHttpServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
        },
        async (base) => {
          await assert.rejects(discoverAuthorizationServerMetadata(base, { allowLoopback: true }), /invalid JSON/);
          assert.strictEqual(await speculativeProbe(undefined, () => discoverAuthorizationServerMetadata(base, { allowLoopback: true })), null);
        }
      );
    });

    it('should return null on invalid URL for a speculative probe and reject otherwise', async () => {
      assert.strictEqual(await speculativeProbe(undefined, () => discoverAuthorizationServerMetadata('not-a-url')), null);
      await assert.rejects(discoverAuthorizationServerMetadata('not-a-url'), /invalid URL/);
    });

    it('should refuse without a loopback grant, even though a server is listening', async () => {
      // Same target as the first test in this block, but with the default
      // (no grant) - this is exactly the SSRF case: an untrusted caller
      // cannot get discovery routed to a loopback address for free. An
      // advertised location rejects; a speculative one reads as "not offered".
      await assert.rejects(discoverAuthorizationServerMetadata('http://localhost:9997'), /Refusing to fetch/);
      assert.strictEqual(await speculativeProbe(undefined, () => discoverAuthorizationServerMetadata('http://localhost:9997')), null);
    });

    it('should reject when the discovery request is aborted in flight', async () => {
      let requestSeen!: () => void;
      const seen = new Promise<void>((resolve) => (requestSeen = resolve));
      await withHttpServer(
        () => requestSeen(),
        async (base) => {
          const controller = new AbortController();
          const reason = new Error('cancelled');
          const pending = discoverAuthorizationServerMetadata(base, { allowLoopback: true, signal: controller.signal });
          await seen;
          controller.abort(reason);
          await assert.rejects(pending, (error: unknown) => error === reason);
        }
      );
    });

    it('should prefer path-local authorization server metadata', async () => {
      const server = await startPathPrefixedWellKnownServer({
        host: '127.0.0.1',
        prefix: '/outlook',
      });
      const baseUrl = server.url;

      try {
        const metadata = await discoverAuthorizationServerMetadata(`${baseUrl}/outlook`, { allowLoopback: true });

        assert.strictEqual(metadata?.issuer, `${baseUrl}/outlook`);
        assert.strictEqual(metadata?.authorization_endpoint, `${baseUrl}/outlook/oauth/authorize`);
      } finally {
        await server.close();
      }
    });
  });
});
