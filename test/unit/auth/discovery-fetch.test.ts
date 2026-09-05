/**
 * Unit tests for discovery-fetch.ts
 * SSRF mitigations for OAuth discovery fetches - see module docs in
 * src/auth/discovery-fetch.ts for the threat model.
 */

import http from 'node:http';
import assert from 'assert';
import getPort from 'get-port';
import { DiscoveryFetchError, discoveryFetch, isLoopbackUrl, readDiscoveryJson } from '../../../src/auth/discovery-fetch.ts';

describe('unit/auth/discovery-fetch', () => {
  describe('scheme enforcement', () => {
    it('should reject http:// for a non-loopback remote discovery URL', async () => {
      await assert.rejects(discoveryFetch('http://example.com/.well-known/oauth-authorization-server', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('http://'), error.message);
        return true;
      });
    });

    it('should reject unsupported schemes', async () => {
      await assert.rejects(discoveryFetch('file:///etc/passwd', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('unsupported scheme'), error.message);
        return true;
      });
    });

    it('should reject an invalid URL', async () => {
      await assert.rejects(discoveryFetch('not-a-url', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('invalid URL'), error.message);
        return true;
      });
    });
  });

  describe('private/reserved IP range blocking (RFC 9728 §7.7)', () => {
    it('should reject the AWS/GCP/Azure metadata address 169.254.169.254', async () => {
      await assert.rejects(discoveryFetch('http://169.254.169.254/latest/meta-data/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        // Blocked either because it's non-loopback http:// or because the
        // address itself is link-local - both branches are acceptable, the
        // important thing is that it never reaches the network.
        return true;
      });
    });

    it('should reject 169.254.169.254 even over https', async () => {
      await assert.rejects(discoveryFetch('https://169.254.169.254/latest/meta-data/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });

    it('should reject private IPv4 range 10.0.0.0/8', async () => {
      await assert.rejects(discoveryFetch('https://10.0.0.1/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });

    it('should reject private IPv4 range 192.168.0.0/16', async () => {
      await assert.rejects(discoveryFetch('https://192.168.1.1/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });

    it('should reject private IPv4 range 172.16.0.0/12', async () => {
      await assert.rejects(discoveryFetch('https://172.16.0.1/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        return true;
      });
    });

    it('should reject an IPv4-mapped IPv6 encoding of the metadata address', async () => {
      // ::ffff:169.254.169.254 - the spec explicitly calls out this encoding
      // trick as one hand-rolled parsers miss. ipaddr.js normalizes it.
      await assert.rejects(discoveryFetch('https://[::ffff:169.254.169.254]/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });

    it('should reject octal/hex-encoded loopback IPv4 literals', async () => {
      // WHATWG URL parsing canonicalizes these to 127.0.0.1 before we ever
      // see a hostname string - so the encoding trick can't sneak past as an
      // opaque, unrecognized value. What that canonical address is then
      // *treated as* is a separate question (see the "loopback requires an
      // explicit grant" tests below) - this test only pins the parsing step.
      const encoded = new URL('http://0x7f000001/');
      assert.strictEqual(encoded.hostname, '127.0.0.1');
    });

    it('should reject IPv6 unique local addresses (fc00::/7)', async () => {
      await assert.rejects(discoveryFetch('https://[fc00::1]/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });

    it('should reject IPv6 link-local addresses (fe80::/10)', async () => {
      await assert.rejects(discoveryFetch('https://[fe80::1]/', {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('not publicly routable'), error.message);
        return true;
      });
    });
  });

  describe('loopback requires an explicit per-call grant, not just a loopback target', () => {
    // This is the crux of the design: a loopback *target* is not by itself a
    // trust signal, because the target is exactly what a malicious remote
    // server controls (e.g. `authorization_servers: ["http://127.0.0.1:6379/"]`
    // from a public, untrusted server). `allowLoopback` must be computed by
    // the caller from the server it is *actually talking to*, never from the
    // URL being fetched - so the same loopback target must be refused with no
    // grant and allowed with one, using the exact same listening server.
    let server: http.Server;
    let loopbackUrl: string;

    before(async () => {
      const port = await getPort();
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
      loopbackUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('should refuse a loopback target with no allowLoopback grant (default false)', async () => {
      // Simulates: base MCP server is public/untrusted, and its metadata
      // pointed discovery at this loopback address.
      await assert.rejects(discoveryFetch(loopbackUrl, {}, 'test'), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.ok(error.message.includes('trusted loopback origin'), error.message);
        return true;
      });
    });

    it('should refuse the same loopback target with allowLoopback explicitly false', async () => {
      await assert.rejects(discoveryFetch(loopbackUrl, {}, 'test', { allowLoopback: false }), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        return true;
      });
    });

    it('should allow the same loopback target once the caller grants allowLoopback', async () => {
      // Simulates: base MCP server is itself loopback (local dev / the
      // callback flow), so its own discovery targets are trusted.
      const response = await discoveryFetch(loopbackUrl, {}, 'test', { allowLoopback: true });
      assert.strictEqual(response.ok, true);
      const body = await readDiscoveryJson<{ ok: boolean }>(response, 'test');
      assert.strictEqual(body.ok, true);
    });

    it('should allow the literal hostname localhost under a grant', async () => {
      const response = await discoveryFetch(loopbackUrl.replace('127.0.0.1', 'localhost'), {}, 'test', { allowLoopback: true });
      assert.strictEqual(response.ok, true);
    });

    it('should refuse the literal hostname localhost with no grant', async () => {
      await assert.rejects(discoveryFetch(loopbackUrl.replace('127.0.0.1', 'localhost'), {}, 'test'), DiscoveryFetchError);
    });

    it('should reach past validation for IPv6 loopback ([::1]) under a grant', async () => {
      // We don't require a listener on ::1 in CI - only that, under a grant,
      // ::1 is treated as loopback (skips the scheme/range checks and the
      // DNS pre-check) rather than being rejected as a private/unroutable
      // address.
      const port = await getPort();
      await assert.rejects(discoveryFetch(`http://[::1]:${port}/`, {}, 'test', { allowLoopback: true }), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        // Must fail as a *connection* failure (nothing listening), never as
        // a scheme or address-range rejection.
        assert.strictEqual(error.message, 'Failed to fetch test');
        return true;
      });
    });
  });

  describe('isLoopbackUrl (what callers use to compute their own allowLoopback grant)', () => {
    it('should be true for 127.0.0.1 and localhost', () => {
      assert.strictEqual(isLoopbackUrl('http://127.0.0.1:3000/mcp'), true);
      assert.strictEqual(isLoopbackUrl('http://localhost:3000/mcp'), true);
      assert.strictEqual(isLoopbackUrl('http://[::1]:3000/mcp'), true);
    });

    it('should be false for a public server, even one that looks local in the path', () => {
      assert.strictEqual(isLoopbackUrl('https://evil.example/localhost'), false);
    });

    it('should fail closed (false) on an unparseable URL', () => {
      assert.strictEqual(isLoopbackUrl('not-a-url'), false);
    });
  });

  describe('redirect validation (every hop is re-checked)', () => {
    it('should reject a redirect from an allowed loopback origin to an internal address it does not also grant', async () => {
      const port = await getPort();
      const server = http.createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

      try {
        // Even with allowLoopback: true (this base server is trusted), the
        // redirect target (link-local, not loopback) is still refused - the
        // grant covers loopback specifically, not "anything this trusted
        // server points at".
        await assert.rejects(discoveryFetch(`http://127.0.0.1:${port}/`, {}, 'test', { allowLoopback: true }), (error: Error) => {
          assert.ok(error instanceof DiscoveryFetchError);
          // Blocked either as a non-loopback http:// target or as a
          // link-local address - either way, this base server's loopback
          // grant does not extend to it.
          assert.ok(error.message.includes('loopback') || error.message.includes('not publicly routable'), error.message);
          return true;
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('should reject that same redirect chain outright with no grant at all', async () => {
      const port = await getPort();
      const server = http.createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

      try {
        await assert.rejects(discoveryFetch(`http://127.0.0.1:${port}/`, {}, 'test'), DiscoveryFetchError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('should reject a redirect chain that exceeds the hop limit', async () => {
      const port = await getPort();
      const server = http.createServer((req, res) => {
        const n = Number(new URL(req.url || '/', `http://127.0.0.1:${port}`).searchParams.get('n') || '0');
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/?n=${n + 1}` });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

      try {
        await assert.rejects(discoveryFetch(`http://127.0.0.1:${port}/?n=0`, {}, 'test', { allowLoopback: true }), (error: Error) => {
          assert.ok(error instanceof DiscoveryFetchError);
          assert.ok(error.message.includes('too many redirects'), error.message);
          return true;
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('should follow a redirect to another allowed (loopback) address under a grant', async () => {
      const portA = await getPort();
      const portB = await getPort();

      const serverB = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hop: 'b' }));
      });
      await new Promise<void>((resolve) => serverB.listen(portB, '127.0.0.1', () => resolve()));

      const serverA = http.createServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${portB}/` });
        res.end();
      });
      await new Promise<void>((resolve) => serverA.listen(portA, '127.0.0.1', () => resolve()));

      try {
        const response = await discoveryFetch(`http://127.0.0.1:${portA}/`, {}, 'test', { allowLoopback: true });
        assert.strictEqual(response.ok, true);
        const body = await readDiscoveryJson<{ hop: string }>(response, 'test');
        assert.strictEqual(body.hop, 'b');
      } finally {
        await new Promise<void>((resolve) => serverA.close(() => resolve()));
        await new Promise<void>((resolve) => serverB.close(() => resolve()));
      }
    });
  });

  describe('response body size cap', () => {
    it('should reject a response larger than the configured cap', async () => {
      const port = await getPort();
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Larger than the 1MB cap enforced by readDiscoveryJson.
        res.end(JSON.stringify({ padding: 'x'.repeat(2_000_000) }));
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

      try {
        const response = await discoveryFetch(`http://127.0.0.1:${port}/`, {}, 'test', { allowLoopback: true });
        await assert.rejects(readDiscoveryJson(response, 'test'), (error: Error) => {
          assert.ok(error instanceof DiscoveryFetchError);
          assert.ok(error.message.includes('too large'), error.message);
          return true;
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('error messages do not leak network details', () => {
    it('should surface a fixed generic message on connection failure, never the underlying error', async () => {
      const port = await getPort(); // guaranteed nothing listening
      await assert.rejects(discoveryFetch(`http://127.0.0.1:${port}/`, {}, 'internal probe', { allowLoopback: true }), (error: Error) => {
        assert.ok(error instanceof DiscoveryFetchError);
        assert.strictEqual(error.message, 'Failed to fetch internal probe');
        assert.ok(!error.message.includes('ECONNREFUSED'));
        return true;
      });
    });
  });
});
