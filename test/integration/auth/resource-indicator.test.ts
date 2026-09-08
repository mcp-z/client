/**
 * The RFC 8707 `resource` indicator sent on every leg of the OAuth flow.
 *
 * This is a regression guard for a live failure: the indicator was derived from
 * the `/mcp`-stripped deployment root, so a server at `https://host/mcp` asked
 * for a token audience-bound to `https://host`. Todoist - the first
 * authorization server we tested that validates the parameter - answered
 * `invalid_target` before the consent screen. Every server whose URL ends in
 * `/mcp` was affected, ours included; the servers we had been testing against
 * simply never read the parameter.
 *
 * Everything here runs against a local authorization server, so the guard needs
 * no provider, no credentials and no human.
 */

import '../../lib/env-loader.ts';
import assert from 'assert';
import http from 'http';
import Keyv from 'keyv';
import { probeAuthCapabilities } from '../../../src/auth/capability-discovery.ts';
import { DcrAuthenticator } from '../../../src/dcr/dcr-authenticator.ts';

interface Received {
  authorize?: string | null;
  token?: string | null;
}

/**
 * An authorization server that records the `resource` it is handed rather than
 * validating it, so a spec can assert on the value instead of on a rejection.
 *
 * `publishPrm: false` drops the RFC 9728 document, which is the fallback path:
 * with nothing declaring the resource's identity, the configured URL stands in.
 */
async function startAuthServer(opts: { publishPrm: boolean }): Promise<{ base: string; received: Received; close: () => Promise<void> }> {
  const received: Received = {};
  let base = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // RFC 9728: published at the resource-specific sub-path, naming the MCP
    // endpoint - not the origin the router happens to be mounted on.
    if (opts.publishPrm && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['test:scope'] });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['test:scope'],
      });
    }

    if (url.pathname === '/register') {
      return json({ client_id: 'test-client', client_secret: 'test-secret', redirect_uris: ['http://localhost/callback'] });
    }

    if (url.pathname === '/authorize') {
      received.authorize = url.searchParams.get('resource');
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', 'test-code');
      const state = url.searchParams.get('state');
      if (state) redirect.searchParams.set('state', state);
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }

    if (url.pathname === '/token') {
      const body = await new Promise<string>((resolve) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => resolve(raw));
      });
      received.token = new URLSearchParams(body).get('resource');
      return json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'Bearer', expires_in: 3600 });
    }

    // The self-hosted path verifies the token it just obtained.
    if (url.pathname === '/oauth/verify') {
      return json({ token: (req.headers.authorization ?? '').replace('Bearer ', '') });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  base = `http://127.0.0.1:${address.port}`;

  return { base, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Drives the flow to completion. Headless mode prints the authorization URL
 * instead of opening a browser, so the spec fetches it itself - the redirect
 * lands on the loopback listener exactly as a real consent click would.
 */
async function authenticate(base: string, mcpServerUrl: string) {
  const capabilities = await probeAuthCapabilities(mcpServerUrl);
  const port = 30000 + Math.floor(Math.random() * 20000);
  const authenticator = new DcrAuthenticator({
    tokenStore: new Keyv(),
    headless: true,
    redirectUri: `http://localhost:${port}/callback`,
    logger: {
      debug: () => {},
      info: (message: string) => {
        if (message.startsWith(`${base}/authorize`)) void fetch(message, { redirect: 'follow' }).catch(() => {});
      },
      warn: () => {},
      error: () => {},
    },
  });

  const tokens = await authenticator.ensureAuthenticated(mcpServerUrl, capabilities);
  return { capabilities, tokens };
}

describe('integration/auth/resource-indicator', () => {
  it('sends the resource the server names in its RFC 9728 metadata, not the stripped base', async () => {
    const { base, received, close } = await startAuthServer({ publishPrm: true });
    try {
      const mcpServerUrl = `${base}/mcp`;
      const { capabilities, tokens } = await authenticate(base, mcpServerUrl);

      assert.strictEqual(capabilities.resource, mcpServerUrl, 'discovery should carry the PRM resource through');
      assert.strictEqual(received.authorize, mcpServerUrl, 'authorization request must audience-bind to the canonical URI');
      assert.strictEqual(received.token, mcpServerUrl, 'token request must carry the same audience');
      assert.strictEqual(tokens.accessToken, 'test-access-token');

      // The regression itself: the deployment root is a different resource.
      assert.notStrictEqual(received.authorize, base);
    } finally {
      await close();
    }
  });

  it('falls back to the configured URL when no protected-resource metadata is published', async () => {
    const { base, received, close } = await startAuthServer({ publishPrm: false });
    try {
      const mcpServerUrl = `${base}/mcp`;
      const { capabilities } = await authenticate(base, mcpServerUrl);

      assert.strictEqual(capabilities.resource, undefined, 'no PRM means nothing to carry');
      assert.strictEqual(received.authorize, mcpServerUrl, 'the configured URL keeps its path when it stands in');
      assert.strictEqual(received.token, mcpServerUrl);
    } finally {
      await close();
    }
  });
});
