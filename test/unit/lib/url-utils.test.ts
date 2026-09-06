/**
 * Unit tests for url-utils.ts
 * Canonical form backs credential store keys and the RFC 8707 resource parameter
 */

import assert from 'assert';
import { joinWellKnown, normalizeUrl } from '../../../src/lib/url-utils.ts';

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
});
