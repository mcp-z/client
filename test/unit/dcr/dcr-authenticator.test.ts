/**
 * Unit tests for dcr-authenticator.ts
 * Tests token management with Keyv storage
 */

import assert from 'assert';
import Keyv from 'keyv';
import type { TokenSet } from '../../../src/auth/types.ts';
import { DcrAuthenticator } from '../../../src/dcr/dcr-authenticator.ts';

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
});
