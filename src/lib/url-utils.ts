export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    // Strip after joining: assigning an empty pathname puts the '/' straight back.
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export function joinWellKnown(baseUrl: string, suffix: string): string {
  return `${normalizeUrl(baseUrl)}${suffix}`;
}

/**
 * Extract the "server base" - where a server's own endpoints live, NOT its identity.
 *
 * The `/mcp` segment names the protocol endpoint; everything before it is the
 * deployment root that `/oauth/verify` and friends hang off. Stripping it is
 * right for building those URLs and wrong for anything that identifies the
 * server: an RFC 8707 `resource` indicator or a credential store key must use
 * the full URL, because the stripped form names a different resource (or none).
 *
 * Original shape by removing a trailing `/mcp` path segment if present.
 * Examples:
 *  - https://example.com/mcp -> https://example.com
 *  - https://example.com/sheets/mcp -> https://example.com/sheets
 *  - https://example.com/sheets/mcp/ -> https://example.com/sheets
 *  - https://example.com/sheets -> https://example.com/sheets
 */
export function extractBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);

  // Ignore query/hash for base URL purposes
  url.search = '';
  url.hash = '';

  // Normalize path segments (removes empty segments from leading/trailing slashes)
  const segments = url.pathname.split('/').filter(Boolean);

  // If last segment is exactly "mcp", drop it
  if (segments[segments.length - 1] === 'mcp') {
    segments.pop();
  }

  // Rebuild pathname; empty means root
  url.pathname = segments.length ? `/${segments.join('/')}` : '';

  // Return without trailing slash (except root origin)
  const out = url.origin + url.pathname;
  return out === url.origin ? out : out.replace(/\/+$/, '');
}
