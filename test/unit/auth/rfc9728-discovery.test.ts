/**
 * Unit tests for RFC 9728 Protected Resource Metadata discovery
 * Tests .well-known/oauth-protected-resource endpoint probing
 */

import assert from 'assert';
import { discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata } from '../../../src/auth/rfc9728-discovery.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.ts';

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

    it('should return null on network error', async () => {
      const metadata = await discoverProtectedResourceMetadata('http://localhost:8887');

      assert.strictEqual(metadata, null);
    });

    it('should use root metadata for paths without specific metadata', async () => {
      // RFC 9728: Root metadata applies to all sub-paths unless overridden
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997/nonexistent');

      // Should return root metadata as it applies to all resources under this origin
      assert.strictEqual(metadata?.resource, 'http://localhost:9997');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
    });

    it('should return null on invalid URL', async () => {
      const metadata = await discoverProtectedResourceMetadata('not-a-url');

      assert.strictEqual(metadata, null);
    });

    it('should handle deep paths like /api/v1/mcp', async () => {
      // Even with deep paths, should check origin first, then sub-path
      const metadata = await discoverProtectedResourceMetadata('http://localhost:9997/api/v1/mcp');

      // Should find metadata at origin (returns resource: baseUrl)
      assert.strictEqual(metadata?.resource, 'http://localhost:9997');
      assert.deepStrictEqual(metadata?.authorization_servers, ['http://localhost:9997']);
    });
  });

  describe('discoverAuthorizationServerMetadata', () => {
    it('should discover authorization server metadata from .well-known endpoint', async () => {
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:9997');

      assert.strictEqual(metadata?.issuer, 'http://localhost:9997');
      assert.strictEqual(metadata?.authorization_endpoint, 'http://localhost:9997/oauth/authorize');
      assert.strictEqual(metadata?.token_endpoint, 'http://localhost:9997/oauth/token');
      assert.strictEqual(metadata?.registration_endpoint, 'http://localhost:9997/oauth/register');
      assert.deepStrictEqual(metadata?.scopes_supported, ['read', 'write']);
    });

    it('should extract origin from URLs with paths', async () => {
      // Should check origin even if given a URL with path
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:9997/some/path');

      assert.strictEqual(metadata?.issuer, 'http://localhost:9997');
      assert.strictEqual(metadata?.authorization_endpoint, 'http://localhost:9997/oauth/authorize');
    });

    it('should return null on network error', async () => {
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:8886');

      assert.strictEqual(metadata, null);
    });

    it('should return null on 404 response', async () => {
      // Use a different port that doesn't have a server
      const metadata = await discoverAuthorizationServerMetadata('http://localhost:7777');

      assert.strictEqual(metadata, null);
    });

    it('should return null on invalid URL', async () => {
      const metadata = await discoverAuthorizationServerMetadata('not-a-url');

      assert.strictEqual(metadata, null);
    });
  });
});
