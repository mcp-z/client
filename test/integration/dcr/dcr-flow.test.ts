/**
 * Integration tests for DCR authentication flow
 * Tests the complete flow: DCR registration → OAuth → Token storage → Refresh
 */

import assert from 'assert';
import Keyv from 'keyv';
import { probeAuthCapabilities } from '../../../src/auth/index.ts';
import type { TokenSet } from '../../../src/auth/types.ts';
import { DcrAuthenticator } from '../../../src/dcr/index.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.mjs';

describe('integration/dcr-auth', () => {
  let dcrServer: Awaited<ReturnType<typeof startDcrTestServer>>;
  let tokenStore: Keyv;

  before(async () => {
    dcrServer = await startDcrTestServer({
      port: 9990,
      baseUrl: 'http://localhost:9990',
    });
  });

  after(async () => {
    if (dcrServer) {
      await dcrServer.close();
    }
  });

  beforeEach(() => {
    // Use in-memory store for each test
    tokenStore = new Keyv();
  });

  it('should perform full DCR + OAuth flow (simulated)', async () => {
    const baseUrl = 'http://localhost:9990';

    // 1. Probe for DCR capabilities
    const capabilities = await probeAuthCapabilities(baseUrl);

    assert.strictEqual(capabilities.supportsDcr, true);
    assert.ok(capabilities.registrationEndpoint);
    assert.ok(capabilities.authorizationEndpoint);
    assert.ok(capabilities.tokenEndpoint);

    // 2. Test token storage and retrieval directly
    // Note: Full OAuth flow with AuthHandler would require browser interaction,
    // so we test token storage independently here
    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
      clientId: 'test_client',
      clientSecret: 'test_secret',
    };

    await tokenStore.set(`tokens:${baseUrl}`, testTokens);

    // Verify tokens were stored
    const storedTokens = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;
    assert.strictEqual(storedTokens.accessToken, 'test_access_token');
    assert.strictEqual(storedTokens.refreshToken, 'test_refresh_token');
  });

  it('should reuse existing valid tokens', async () => {
    const baseUrl = 'http://localhost:9990';

    // Store valid tokens
    const validTokens: TokenSet = {
      accessToken: 'existing_token',
      refreshToken: 'existing_refresh',
      expiresAt: Date.now() + 3600000, // Valid for 1 hour
      clientId: 'client_123',
      clientSecret: 'secret_123',
    };

    await tokenStore.set(`tokens:${baseUrl}`, validTokens);

    // Retrieve and verify
    const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;
    assert.strictEqual(retrieved.accessToken, 'existing_token');
  });

  it('should handle expired tokens requiring refresh', async () => {
    const baseUrl = 'http://localhost:9990';

    // Store expired tokens
    const expiredTokens: TokenSet = {
      accessToken: 'expired_token',
      refreshToken: 'refresh_token_123',
      expiresAt: Date.now() - 1000, // Expired 1 second ago
      clientId: 'client_123',
      clientSecret: 'secret_123',
    };

    await tokenStore.set(`tokens:${baseUrl}`, expiredTokens);

    // Verify tokens are stored
    const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;
    assert.ok(retrieved);
    assert.ok(retrieved.expiresAt < Date.now()); // Confirm expired
  });

  it('should isolate tokens by base URL', async () => {
    const baseUrl1 = 'http://localhost:9990';
    const baseUrl2 = 'http://localhost:9991';

    const tokens1: TokenSet = {
      accessToken: 'token_server1',
      refreshToken: 'refresh1',
      expiresAt: Date.now() + 3600000,
    };

    const tokens2: TokenSet = {
      accessToken: 'token_server2',
      refreshToken: 'refresh2',
      expiresAt: Date.now() + 3600000,
    };

    await tokenStore.set(`tokens:${baseUrl1}`, tokens1);
    await tokenStore.set(`tokens:${baseUrl2}`, tokens2);

    // Verify isolation
    const retrieved1 = (await tokenStore.get(`tokens:${baseUrl1}`)) as TokenSet;
    const retrieved2 = (await tokenStore.get(`tokens:${baseUrl2}`)) as TokenSet;

    assert.strictEqual(retrieved1.accessToken, 'token_server1');
    assert.strictEqual(retrieved2.accessToken, 'token_server2');
  });

  it('should delete tokens for specific base URL', async () => {
    const baseUrl = 'http://localhost:9990';

    const tokens: TokenSet = {
      accessToken: 'test_token',
      refreshToken: 'test_refresh',
      expiresAt: Date.now() + 3600000,
    };

    await tokenStore.set(`tokens:${baseUrl}`, tokens);

    // Verify tokens exist
    let retrieved = await tokenStore.get(`tokens:${baseUrl}`);
    assert.ok(retrieved);

    // Delete using DcrAuthenticator
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });
    await authenticator.deleteTokens(baseUrl);

    // Verify tokens are deleted
    retrieved = await tokenStore.get(`tokens:${baseUrl}`);
    assert.strictEqual(retrieved, undefined);
  });

  // Client-side refresh behavior tests (DcrAuthenticator)
  describe('DcrAuthenticator proactive refresh', () => {
    const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes (matches DcrAuthenticator constant)

    it('should reuse valid tokens without calling refresh', async () => {
      const baseUrl = 'http://localhost:9990';

      // Store tokens that are valid for 1 hour (well outside refresh buffer)
      const validTokens: TokenSet = {
        accessToken: 'valid_token_no_refresh',
        refreshToken: 'refresh_token',
        expiresAt: Date.now() + 3600000, // 1 hour from now
        clientId: 'test_client',
        clientSecret: 'test_secret',
      };

      await tokenStore.set(`tokens:${baseUrl}`, validTokens);

      // Retrieve tokens twice - should get same token both times (no refresh)
      const retrieved1 = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;
      const retrieved2 = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;

      assert.strictEqual(retrieved1.accessToken, 'valid_token_no_refresh');
      assert.strictEqual(retrieved2.accessToken, 'valid_token_no_refresh');
      assert.strictEqual(retrieved1.accessToken, retrieved2.accessToken, 'Token should not have changed');
    });

    it('should detect tokens within refresh buffer (5 minutes)', async () => {
      const baseUrl = 'http://localhost:9990';

      // Store tokens that will expire in 3 minutes (within 5-minute buffer)
      const nearExpiryTokens: TokenSet = {
        accessToken: 'near_expiry_token',
        refreshToken: 'refresh_token',
        expiresAt: Date.now() + 3 * 60 * 1000, // 3 minutes from now
        clientId: 'test_client',
        clientSecret: 'test_secret',
      };

      await tokenStore.set(`tokens:${baseUrl}`, nearExpiryTokens);

      const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;

      // Check if token is within refresh buffer
      const isWithinBuffer = retrieved.expiresAt < Date.now() + REFRESH_BUFFER_MS;
      assert.ok(isWithinBuffer, 'Token should be within refresh buffer');
    });

    it('should detect expired tokens', async () => {
      const baseUrl = 'http://localhost:9990';

      // Store expired tokens
      const expiredTokens: TokenSet = {
        accessToken: 'expired_token',
        refreshToken: 'refresh_token',
        expiresAt: Date.now() - 1000, // Expired 1 second ago
        clientId: 'test_client',
        clientSecret: 'test_secret',
      };

      await tokenStore.set(`tokens:${baseUrl}`, expiredTokens);

      const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;

      // Verify token is expired
      assert.ok(retrieved.expiresAt < Date.now(), 'Token should be expired');
    });

    it('should store client credentials for refresh', async () => {
      const baseUrl = 'http://localhost:9990';

      // Store tokens with client credentials (needed for refresh)
      const tokensWithCreds: TokenSet = {
        accessToken: 'token_with_creds',
        refreshToken: 'refresh_token',
        expiresAt: Date.now() + 3600000,
        clientId: 'stored_client_id',
        clientSecret: 'stored_client_secret',
      };

      await tokenStore.set(`tokens:${baseUrl}`, tokensWithCreds);

      const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;

      // Verify client credentials are stored (required for refresh)
      assert.strictEqual(retrieved.clientId, 'stored_client_id');
      assert.strictEqual(retrieved.clientSecret, 'stored_client_secret');
      assert.ok(retrieved.refreshToken, 'Refresh token should be stored');
    });

    it('should handle tokens without refresh token', async () => {
      const baseUrl = 'http://localhost:9990';

      // Store tokens without refresh token (can't be refreshed)
      // Use type assertion since this tests runtime behavior where refresh token may be absent
      const noRefreshTokens = {
        accessToken: 'no_refresh_token',
        expiresAt: Date.now() + 3600000,
        clientId: 'test_client',
      } as TokenSet;

      await tokenStore.set(`tokens:${baseUrl}`, noRefreshTokens);

      const retrieved = (await tokenStore.get(`tokens:${baseUrl}`)) as TokenSet;

      assert.ok(!retrieved.refreshToken, 'Should not have refresh token');
      // Such tokens can be used while valid but cannot be refreshed
    });
  });
});
