/**
 * Unit tests for capability-discovery.ts
 * Tests RFC 8414 .well-known endpoint probing
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
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
    const port = await getPort();
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
    const port = await getPort();
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
    const port = await getPort();
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

  it('should return supportsDcr=false on network error', async () => {
    const capabilities = await probeAuthCapabilities('http://localhost:8888');

    assert.strictEqual(capabilities.supportsDcr, false);
    assert.strictEqual(capabilities.registrationEndpoint, undefined);
    assert.strictEqual(capabilities.authorizationEndpoint, undefined);
    assert.strictEqual(capabilities.tokenEndpoint, undefined);
  });

  it('should return supportsDcr=false on invalid URL', async () => {
    const capabilities = await probeAuthCapabilities('not-a-url');

    assert.strictEqual(capabilities.supportsDcr, false);
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
