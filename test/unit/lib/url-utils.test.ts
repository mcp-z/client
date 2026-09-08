/**
 * Unit tests for url-utils.ts
 * Canonical form backs credential store keys and the RFC 8707 resource parameter
 */

import '../../lib/env-loader.ts';
import assert from 'assert';
import { extractBaseUrl, joinWellKnown, normalizeUrl } from '../../../src/lib/url-utils.ts';

describe('unit/lib/url-utils', () => {
  it('should drop the trailing slash of a root URL', () => {
    assert.strictEqual(normalizeUrl('https://example.com/'), 'https://example.com');
    assert.strictEqual(normalizeUrl('https://example.com'), 'https://example.com');
  });

  it('should drop trailing slashes of a path URL', () => {
    assert.strictEqual(normalizeUrl('https://example.com/mcp/'), 'https://example.com/mcp');
    assert.strictEqual(normalizeUrl('https://example.com/api/v1/mcp//'), 'https://example.com/api/v1/mcp');
  });

  it('should drop query and fragment', () => {
    assert.strictEqual(normalizeUrl('https://example.com/mcp?token=abc#frag'), 'https://example.com/mcp');
  });

  it('should fall back to trimming an unparseable input', () => {
    assert.strictEqual(normalizeUrl('not-a-url/'), 'not-a-url');
  });

  it('should join a well-known suffix with a single separator', () => {
    assert.strictEqual(joinWellKnown('https://example.com/', '/.well-known/oauth-authorization-server'), 'https://example.com/.well-known/oauth-authorization-server');
    assert.strictEqual(joinWellKnown('https://example.com/outlook', '/.well-known/oauth-protected-resource'), 'https://example.com/outlook/.well-known/oauth-protected-resource');
  });
  describe('extractBaseUrl', () => {
    // The deployment root a server's own endpoints hang off, which is NOT its
    // identity. Sending this where the canonical URI belongs is what made
    // authorization servers answer `invalid_target`; see resource-indicator.test.ts.
    it('drops a trailing /mcp segment', () => {
      assert.strictEqual(extractBaseUrl('https://example.com/mcp'), 'https://example.com');
      assert.strictEqual(extractBaseUrl('https://example.com/mcp/'), 'https://example.com');
    });

    it('keeps a path prefix, dropping only the /mcp below it', () => {
      assert.strictEqual(extractBaseUrl('https://example.com/sheets/mcp'), 'https://example.com/sheets');
      assert.strictEqual(extractBaseUrl('https://example.com/sheets/mcp/'), 'https://example.com/sheets');
    });

    it('leaves a URL that does not end in /mcp alone', () => {
      assert.strictEqual(extractBaseUrl('https://example.com/sheets'), 'https://example.com/sheets');
      assert.strictEqual(extractBaseUrl('https://example.com'), 'https://example.com');
      assert.strictEqual(extractBaseUrl('https://example.com/'), 'https://example.com');
    });

    it('only strips the last segment, never an /mcp in the middle', () => {
      assert.strictEqual(extractBaseUrl('https://example.com/mcp/v1'), 'https://example.com/mcp/v1');
    });

    it('ignores query and hash', () => {
      assert.strictEqual(extractBaseUrl('https://example.com/mcp?a=1#f'), 'https://example.com');
      assert.strictEqual(extractBaseUrl('https://example.com/sheets/mcp?a=1'), 'https://example.com/sheets');
    });

    it('differs from normalizeUrl exactly where the bug lived', () => {
      // normalizeUrl preserves identity; extractBaseUrl discards it. Two names,
      // two jobs - the pair that was conflated.
      assert.strictEqual(normalizeUrl('https://example.com/mcp'), 'https://example.com/mcp');
      assert.strictEqual(extractBaseUrl('https://example.com/mcp'), 'https://example.com');
    });
  });
});
