/**
 * Unit tests for dcr-authenticator.ts
 * Tests token management with Keyv storage
 */

import type { AuthCapabilities, TokenSet } from '@mcp-z/client';
import { DcrAuthenticator } from '@mcp-z/client';
import assert from 'assert';
import Keyv from 'keyv';

describe('unit/auth/dcr-authenticator', () => {
  it('should use custom token store when provided', () => {
    const customStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore: customStore, redirectUri: 'http://localhost:3000/callback' });

    assert.ok(authenticator);
  });

  it('should delete tokens for a base URL', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    // Manually add tokens to store
    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
      clientId: 'test_client',
      clientSecret: 'test_secret',
    };

    await tokenStore.set('tokens:http://example.com', testTokens);

    // Verify tokens exist
    const storedTokens = await tokenStore.get('tokens:http://example.com');
    assert.ok(storedTokens);

    // Delete tokens
    await authenticator.deleteTokens('http://example.com');

    // Verify tokens are deleted
    const deletedTokens = await tokenStore.get('tokens:http://example.com');
    assert.strictEqual(deletedTokens, undefined);
  });

  it('should delete both token families for a base URL', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
    };

    // This class writes two families: `tokens:` for external OAuth and
    // `dcr-tokens:` for self-hosted DCR. Deleting per-family leaves a usable
    // credential behind for a caller that believes it revoked them.
    await tokenStore.set('tokens:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    assert.strictEqual(await tokenStore.get('tokens:http://example.com'), undefined);
    assert.strictEqual(await tokenStore.get('dcr-tokens:http://example.com'), undefined, 'self-hosted DCR tokens must go too');
    assert.ok(await tokenStore.get('dcr-tokens:http://other.example.com'), 'other resources are left alone');
  });

  it('should key tokens by base URL', async () => {
    const tokenStore = new Keyv();

    // Add tokens for different base URLs
    const tokens1: TokenSet = {
      accessToken: 'token1',
      refreshToken: 'refresh1',
      expiresAt: Date.now() + 3600000,
    };

    const tokens2: TokenSet = {
      accessToken: 'token2',
      refreshToken: 'refresh2',
      expiresAt: Date.now() + 3600000,
    };

    await tokenStore.set('tokens:http://server1.com', tokens1);
    await tokenStore.set('tokens:http://server2.com', tokens2);

    // Verify isolation
    const retrieved1 = (await tokenStore.get('tokens:http://server1.com')) as TokenSet;
    const retrieved2 = (await tokenStore.get('tokens:http://server2.com')) as TokenSet;

    assert.strictEqual(retrieved1.accessToken, 'token1');
    assert.strictEqual(retrieved2.accessToken, 'token2');
  });

  it('should support headless mode', () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({
      tokenStore,
      redirectUri: 'http://localhost:3000/callback',
      headless: true,
    });

    assert.ok(authenticator);
  });

  it('should refuse DCR registration when a public server points registration_endpoint at loopback (SSRF)', async () => {
    // This is the exact attack the loopback-trust design exists to stop:
    // baseUrl is a public server (never itself fetched by ensureAuthenticated
    // for the external/non-self-hosted path - only used as a trust signal
    // and a token-store key), and its AS metadata (represented here by
    // `capabilities`, as if already discovered) points registration_endpoint
    // at a loopback service the operator did not intend to expose. Because
    // baseUrl is public, allowLoopback is computed as false, and the POST
    // must be refused before any request is sent - regardless of whether
    // anything happens to be listening on that port.
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    const maliciousCapabilities: AuthCapabilities = {
      supportsDcr: true,
      registrationEndpoint: 'http://localhost:9998/oauth/register',
      authorizationEndpoint: 'http://localhost:9998/oauth/authorize',
      tokenEndpoint: 'http://localhost:9998/oauth/token',
    };

    await assert.rejects(authenticator.ensureAuthenticated('https://public.example.com/mcp', maliciousCapabilities), (error: Error) => {
      assert.ok(error.message.includes('trusted loopback origin'), error.message);
      return true;
    });
  });
});
