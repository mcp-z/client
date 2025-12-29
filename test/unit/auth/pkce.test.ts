/**
 * Unit tests for PKCE (Proof Key for Code Exchange) generation
 * Tests RFC 7636 implementation using oauth4webapi
 */

import assert from 'assert';
import { generatePkce } from '../../../src/auth/pkce.ts';

describe('unit/auth/pkce', () => {
  describe('generatePkce', () => {
    it('should generate valid PKCE parameters', async () => {
      const pkce = await generatePkce();

      // Verify all fields are present
      assert.ok(pkce.codeVerifier, 'Should have code verifier');
      assert.ok(pkce.codeChallenge, 'Should have code challenge');
      assert.strictEqual(pkce.codeChallengeMethod, 'S256', 'Should use S256 method');
    });

    it('should generate code verifier with correct length', async () => {
      const pkce = await generatePkce();

      // RFC 7636 § 4.1: code verifier must be 43-128 characters
      assert.ok(pkce.codeVerifier.length >= 43, 'Code verifier should be at least 43 characters');
      assert.ok(pkce.codeVerifier.length <= 128, 'Code verifier should be at most 128 characters');
    });

    it('should generate URL-safe base64 strings', async () => {
      const pkce = await generatePkce();

      // RFC 7636: Use unreserved characters [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
      const urlSafePattern = /^[A-Za-z0-9\-._~]+$/;

      assert.ok(urlSafePattern.test(pkce.codeVerifier), 'Code verifier should be URL-safe');
      assert.ok(urlSafePattern.test(pkce.codeChallenge), 'Code challenge should be URL-safe');
    });

    it('should generate unique values on each call', async () => {
      const pkce1 = await generatePkce();
      const pkce2 = await generatePkce();

      // Each generation should be cryptographically random
      assert.notStrictEqual(pkce1.codeVerifier, pkce2.codeVerifier, 'Code verifiers should be different');
      assert.notStrictEqual(pkce1.codeChallenge, pkce2.codeChallenge, 'Code challenges should be different');
    });

    it('should generate code challenge different from verifier', async () => {
      const pkce = await generatePkce();

      // Code challenge is SHA-256 hash of verifier, should never match
      assert.notStrictEqual(pkce.codeChallenge, pkce.codeVerifier, 'Challenge should differ from verifier');
    });
  });
});
