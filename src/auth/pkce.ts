/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Implements RFC 7636 for OAuth 2.0 public client security
 */

import { createHash, randomBytes } from 'node:crypto';
import type { PkceParams } from './types.ts';

/**
 * Generate random code verifier for PKCE (RFC 7636 Section 4.1)
 * Returns cryptographically random string of 43-128 characters using base64url encoding
 */
function generateRandomCodeVerifier(): string {
  // RFC 7636 recommends 43-128 characters
  // Using 32 random bytes -> 43 base64url characters
  return randomBytes(32).toString('base64url');
}

/**
 * Calculate PKCE code challenge from code verifier (RFC 7636 Section 4.2)
 * Uses S256 method: BASE64URL(SHA256(ASCII(code_verifier)))
 */
async function calculatePKCECodeChallenge(codeVerifier: string): Promise<string> {
  const hash = createHash('sha256').update(codeVerifier, 'ascii').digest();
  return Buffer.from(hash).toString('base64url');
}

/**
 * Generate PKCE parameters for OAuth 2.0 authorization code flow
 * Uses S256 method (SHA-256 hash) as recommended by RFC 7636
 *
 * @returns PkceParams with code verifier, challenge, and method
 *
 * @example
 * const pkce = await generatePkce();
 * // Use pkce.codeChallenge and pkce.codeChallengeMethod in authorization URL
 * // Store pkce.codeVerifier for token exchange
 */
export async function generatePkce(): Promise<PkceParams> {
  // Generate cryptographically random code verifier (RFC 7636 § 4.1)
  const codeVerifier = generateRandomCodeVerifier();

  // Generate code challenge using S256 method (RFC 7636 § 4.2)
  // S256: BASE64URL(SHA256(ASCII(code_verifier)))
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}
