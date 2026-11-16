/**
 * Unit tests for capability-discovery.ts
 * Tests RFC 8414 .well-known endpoint probing
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeAuthCapabilities } from '@mcp-z/client';
import assert from 'assert';
import getPort from 'get-port';
import { probeAuthCapabilities as probeAuthCapabilitiesFromSource } from '../../../src/auth/capability-discovery.ts';
import { withAbortTimeout } from '../../../src/connection/connect-client.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.mjs';
import { withDeadline } from '../../lib/with-deadline.ts';

describe('unit/auth/capability-discovery', () => {
  let dcrServer: Awaited<ReturnType<typeof startDcrTestServer>>;

  before(async () => {
    dcrServer = await startDcrTestServer({
      port: 9999,
      baseUrl: 'http://localhost:9999',
    });
  });

  after(async () => {
    await dcrServer.close();
  });

  it('should stop capability discovery immediately when its signal is already aborted', async () => {
    let requestCount = 0;
    const server = http.createServer(() => {
      requestCount += 1;
    });
    const port = await getPort({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const controller = new AbortController();
    const reason = new Error('discovery cancelled before it started');
    controller.abort(reason);

    try {
      await assert.rejects(withDeadline(probeAuthCapabilitiesFromSource(`http://127.0.0.1:${port}/mcp`, { signal: controller.signal }), 1000), (error: unknown) => error === reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(requestCount, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should cancel the in-flight local resource-discovery request and release its socket', async () => {
    let requestSeen!: () => void;
    let socketClosed!: () => void;
    const seen = new Promise<void>((resolve) => (requestSeen = resolve));
    const closed = new Promise<void>((resolve) => (socketClosed = resolve));
    const server = http.createServer((request) => {
      requestSeen();
      request.socket.once('close', socketClosed);
    });
    const port = await getPort({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const controller = new AbortController();
    const reason = new Error('resource discovery cancelled');

    try {
      const pending = probeAuthCapabilitiesFromSource(`http://127.0.0.1:${port}/mcp`, { signal: controller.signal });
      await withDeadline(seen, 1000);
      controller.abort(reason);
      await assert.rejects(withDeadline(pending, 1000), (error: unknown) => error === reason);
      await withDeadline(closed, 1000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should abort capability discovery at its timeout and release the request socket', async () => {
    let requestSeen!: () => void;
    let socketClosed!: () => void;
    const seen = new Promise<void>((resolve) => (requestSeen = resolve));
    const closed = new Promise<void>((resolve) => (socketClosed = resolve));
    const server = http.createServer((request) => {
      requestSeen();
      request.socket.once('close', socketClosed);
    });
    const port = await getPort({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
      const pending = withAbortTimeout((signal) => probeAuthCapabilitiesFromSource(`http://127.0.0.1:${port}/mcp`, { signal }), 250, 'local capability discovery');
      await withDeadline(seen, 1000);
      await assert.rejects(withDeadline(pending, 1000), /Timeout after 250ms: local capability discovery/);
      await withDeadline(closed, 1000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should detect DCR support from .well-known endpoint', async () => {
    const capabilities = await probeAuthCapabilities('http://localhost:9999');

    assert.strictEqual(capabilities.supportsDcr, true);
    assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
    assert.strictEqual(capabilities.authorizationEndpoint, 'http://localhost:9999/oauth/authorize');
    assert.strictEqual(capabilities.tokenEndpoint, 'http://localhost:9999/oauth/token');
    assert.strictEqual(capabilities.issuer, 'http://localhost:9999');
    assert.strictEqual(capabilities.authorizationResponseIssSupported, false);
    assert.deepStrictEqual(capabilities.scopes, ['read', 'write']);
  });

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

  it('should return supportsDcr=false on network error (nothing advertised)', async () => {
    const capabilities = await probeAuthCapabilities('http://localhost:8888');

    assert.deepStrictEqual(capabilities, { supportsDcr: false });
  });

  it('should return supportsDcr=false on invalid URL', async () => {
    assert.deepStrictEqual(await probeAuthCapabilities('not-a-url'), { supportsDcr: false });
  });

  it('should return supportsDcr=false when the server offers no OAuth metadata (404 everywhere)', async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(404).end();
      },
      async (base) => {
        assert.deepStrictEqual(await probeAuthCapabilities(`${base}/mcp`), { supportsDcr: false });
      }
    );
  });

  it('should return supportsDcr=false for an auth-less server that answers 200 HTML everywhere', async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>app</body></html>');
      },
      async (base) => {
        assert.deepStrictEqual(await probeAuthCapabilities(`${base}/mcp`), { supportsDcr: false });
      }
    );
  });

  it('should return supportsDcr=false for an auth-less server that redirects well-known paths to a login page', async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url === '/login') res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
        else res.writeHead(302, { location: '/login' }).end();
      },
      async (base) => {
        assert.deepStrictEqual(await probeAuthCapabilities(`${base}/mcp`), { supportsDcr: false });
      }
    );
  });

  it('should return supportsDcr=false for an auth-less server whose paths redirect in a loop', async () => {
    await withHttpServer(
      (req, res) => {
        res.writeHead(302, { location: req.url ?? '/' }).end();
      },
      async (base) => {
        assert.deepStrictEqual(await probeAuthCapabilities(`${base}/mcp`), { supportsDcr: false });
      }
    );
  });

  it('should return supportsDcr=false when the origin authorization-server probe returns invalid JSON (nothing advertised)', async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url?.includes('oauth-authorization-server')) res.writeHead(200, { 'content-type': 'application/json' }).end('{broken');
        else res.writeHead(404).end();
      },
      async (base) => {
        assert.deepStrictEqual(await probeAuthCapabilities(`${base}/mcp`), { supportsDcr: false });
      }
    );
  });

  // Locations the server advertised are not guesses: failures there reach the caller.
  describe('advertised locations (strict)', () => {
    it('should reject when resource_metadata points at a refused address (SSRF) instead of connecting without auth', async () => {
      await withHttpServer(
        (_req, res) => {
          res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://10.0.0.1/meta"' }).end();
        },
        async (base) => {
          await assert.rejects(probeAuthCapabilities(`${base}/mcp`), /Refusing to fetch/);
        }
      );
    });

    it('should reject when the authorization server named by the resource metadata returns invalid JSON', async () => {
      await withHttpServer(
        (req, res) => {
          const origin = `http://${req.headers.host}`;
          if (req.url?.startsWith('/.well-known/oauth-protected-resource')) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: origin, authorization_servers: [origin] }));
          else if (req.url?.includes('oauth-authorization-server')) res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
          else res.writeHead(404).end();
        },
        async (base) => {
          await assert.rejects(probeAuthCapabilities(base), /invalid JSON/);
        }
      );
    });

    it('should reject when the authorization server named by the resource metadata is unreachable', async () => {
      await withHttpServer(
        (req, res) => {
          if (req.url?.startsWith('/.well-known/oauth-protected-resource')) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `http://${req.headers.host}`, authorization_servers: ['http://127.0.0.1:1'] }));
          else res.writeHead(404).end();
        },
        async (base) => {
          await assert.rejects(probeAuthCapabilities(base), /Failed to fetch/);
        }
      );
    });

    it('should reject when the issuer advertised in WWW-Authenticate returns invalid JSON', async () => {
      await withHttpServer(
        (req, res) => {
          if (req.url?.includes('oauth-authorization-server')) res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
          else res.writeHead(401, { 'www-authenticate': `Bearer authorization_server="http://${req.headers.host}"` }).end();
        },
        async (base) => {
          await assert.rejects(probeAuthCapabilities(`${base}/mcp`), /invalid JSON/);
        }
      );
    });
  });

  describe('MCP endpoint path handling (BUG FIX)', () => {
    it('should extract origin from MCP endpoint with /mcp path [CURRENTLY FAILS]', async () => {
      // Test Case: MCP at http://localhost:9999/mcp
      // Should check: http://localhost:9999/.well-known/oauth-authorization-server
      // Currently FAILS because it checks: http://localhost:9999/mcp/.well-known/...

      const capabilities = await probeAuthCapabilities('http://localhost:9999/mcp');

      assert.strictEqual(capabilities.supportsDcr, true, 'Should discover DCR from origin');
      assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
      assert.strictEqual(capabilities.authorizationEndpoint, 'http://localhost:9999/oauth/authorize');
    });

    it('should handle deep paths like /api/v1/mcp [CURRENTLY FAILS]', async () => {
      const capabilities = await probeAuthCapabilities('http://localhost:9999/api/v1/mcp');

      assert.strictEqual(capabilities.supportsDcr, true, 'Should discover DCR from origin regardless of path depth');
      assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
    });

    it('should continue working for origin-only URLs (regression test)', async () => {
      // Ensure we didn't break existing functionality
      const capabilities = await probeAuthCapabilities('http://localhost:9999');

      assert.strictEqual(capabilities.supportsDcr, true);
      assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
    });

    it('should ignore query and fragment on MCP endpoint', async () => {
      const capabilities = await probeAuthCapabilities('http://localhost:9999/mcp?foo=bar#baz');

      assert.strictEqual(capabilities.supportsDcr, true);
      assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
      assert.strictEqual(capabilities.authorizationEndpoint, 'http://localhost:9999/oauth/authorize');
    });
  });
});
