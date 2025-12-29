/**
 * Unit tests for capability-discovery.ts
 * Tests RFC 8414 .well-known endpoint probing
 */

import assert from 'assert';
import { probeAuthCapabilities } from '../../../src/auth/capability-discovery.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.ts';

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

  it('should detect DCR support from .well-known endpoint', async () => {
    const capabilities = await probeAuthCapabilities('http://localhost:9999');

    assert.strictEqual(capabilities.supportsDcr, true);
    assert.strictEqual(capabilities.registrationEndpoint, 'http://localhost:9999/oauth/register');
    assert.strictEqual(capabilities.authorizationEndpoint, 'http://localhost:9999/oauth/authorize');
    assert.strictEqual(capabilities.tokenEndpoint, 'http://localhost:9999/oauth/token');
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
  });
});
