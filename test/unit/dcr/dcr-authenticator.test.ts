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

    await tokenStore.set('tokens:https://issuer.example.com:http://example.com', testTokens);
    await tokenStore.set('tokens:https://issuer.example.com:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    assert.strictEqual(await tokenStore.get('tokens:https://issuer.example.com:http://example.com'), undefined);
    assert.ok(await tokenStore.get('tokens:https://issuer.example.com:http://other.example.com'), 'other resources are left alone');
  });

  it('should delete self-hosted DCR tokens for a base URL', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
    };

    await tokenStore.set('dcr-tokens:https://issuer.example.com:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:https://issuer.example.com:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    assert.strictEqual(await tokenStore.get('dcr-tokens:https://issuer.example.com:http://example.com'), undefined);
    assert.ok(await tokenStore.get('dcr-tokens:https://issuer.example.com:http://other.example.com'), 'other resources are left alone');
  });

  // Credentials are keyed and stamped by issuer, so a resource whose
  // authorization server changes gets a fresh authorization rather than the
  // previous server's tokens (SEP-2352). Each case below stores a credential
  // for ISSUER_A and then discovers capabilities that carry no endpoints, so
  // "did it reuse the stored credential?" is answered by whether the call
  // returns the token or falls through to the missing-endpoints failure.
  const ISSUER_A = 'https://issuer-a.example.com';
  const ISSUER_B = 'https://issuer-b.example.com';
  const RESOURCE = 'https://resource.example.com';
  const STORED_KEY = `tokens:${ISSUER_A}:${RESOURCE}`;

  function storedTokens(issuer?: string): TokenSet {
    const tokens: TokenSet = {
      accessToken: 'stored_access_token',
      refreshToken: 'stored_refresh_token',
      expiresAt: Date.now() + 3600000,
      clientId: 'stored_client',
      clientSecret: 'stored_secret',
    };
    if (issuer) tokens.issuer = issuer;
    return tokens;
  }

  it('should reuse a credential stored for the discovered issuer', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens(ISSUER_A));
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    const tokens = await authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_A });

    assert.strictEqual(tokens.accessToken, 'stored_access_token');
  });

  it('should never present a stored credential to a different authorization server', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens(ISSUER_A));
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_B }), (error: Error) => {
      assert.ok(error.message.includes('does not provide required OAuth endpoints'), error.message);
      return true;
    });

    assert.ok(await tokenStore.get(STORED_KEY), "issuer A's credential is untouched, not handed to issuer B");
  });

  it('should discard a stored credential that carries no issuer', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens());
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_A }), (error: Error) => {
      assert.ok(error.message.includes('does not provide required OAuth endpoints'), error.message);
      return true;
    });

    assert.strictEqual(await tokenStore.get(STORED_KEY), undefined, 'unbound credential is discarded, not reused');
  });

  it('should refuse to authenticate against an authorization server that advertises no issuer', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true }), (error: Error) => {
      assert.ok(error.message.includes('has no issuer'), error.message);
      return true;
    });
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
      issuer: 'http://localhost:9998',
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
