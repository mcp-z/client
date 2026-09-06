/**
 * Unit tests for interactive-oauth-flow.ts
 * Drives the real loopback callback listener against a real token endpoint
 */

import http from 'node:http';
import type { Logger, OAuthFlowOptions } from '@mcp-z/client';
import { InteractiveOAuthFlow } from '@mcp-z/client';
import assert from 'assert';
import getPort from 'get-port';

const ISSUER = 'https://issuer.example.com';
const RESOURCE = 'https://resource.example.com/mcp';

interface TokenEndpoint {
  url: string;
  bodies: URLSearchParams[];
  close: () => Promise<void>;
}

async function startTokenEndpoint(): Promise<TokenEndpoint> {
  const port = await getPort();
  const bodies: URLSearchParams[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      bodies.push(new URLSearchParams(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'access_granted', refresh_token: 'refresh_granted', expires_in: 3600, scope: 'read write' }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  return {
    url: `http://localhost:${port}/token`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Headless mode prints the authorization URL once the callback listener is bound, so awaiting it also sequences the callback below. */
function createAuthorizeUrlRecorder(): { logger: Logger; authorizeUrl: Promise<URL> } {
  let resolveUrl: (url: URL) => void;
  const authorizeUrl = new Promise<URL>((resolve) => {
    resolveUrl = resolve;
  });
  const noop = () => {};

  return {
    logger: {
      info: (message: unknown) => {
        if (typeof message === 'string' && message.startsWith('http')) resolveUrl(new URL(message));
      },
      debug: noop,
      warn: noop,
      error: noop,
    },
    authorizeUrl,
  };
}

async function deliverCallback(redirectUri: string, params: Record<string, string>): Promise<void> {
  const response = await fetch(`${redirectUri}?${new URLSearchParams(params)}`);
  await response.text();
}

describe('unit/auth/interactive-oauth-flow', () => {
  let tokenEndpoint: TokenEndpoint;

  beforeEach(async () => {
    tokenEndpoint = await startTokenEndpoint();
  });

  afterEach(async () => {
    await tokenEndpoint.close();
  });

  async function runFlow(callbackParams: Record<string, string>, overrides: Partial<OAuthFlowOptions> = {}) {
    const port = await getPort();
    const redirectUri = `http://localhost:${port}/callback`;
    const recorder = createAuthorizeUrlRecorder();

    const options: OAuthFlowOptions = {
      port,
      issuer: ISSUER,
      resource: RESOURCE,
      redirectUri,
      pkce: true,
      headless: true,
      allowLoopback: true,
      timeout: 10000,
      logger: recorder.logger,
      ...overrides,
    };

    const flow = new InteractiveOAuthFlow();
    const tokens = flow.performAuthFlow('https://issuer.example.com/authorize', tokenEndpoint.url, 'client-id', 'client-secret', options);
    // Callers assert on the rejection only after delivering the callback below.
    tokens.catch(() => {});

    const authorizeUrl = await recorder.authorizeUrl;
    await deliverCallback(redirectUri, callbackParams);

    return { authorizeUrl, tokens };
  }

  it('binds the authorization and token requests to the resource (RFC 8707)', async () => {
    const { authorizeUrl, tokens } = await runFlow({ code: 'auth_code_1', iss: ISSUER });
    const result = await tokens;

    assert.strictEqual(authorizeUrl.searchParams.get('resource'), RESOURCE);
    assert.strictEqual(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');

    assert.strictEqual(tokenEndpoint.bodies.length, 1);
    const body = tokenEndpoint.bodies[0] as URLSearchParams;
    assert.strictEqual(body.get('resource'), RESOURCE);
    assert.strictEqual(body.get('grant_type'), 'authorization_code');
    assert.ok(body.get('code_verifier'), 'PKCE verifier should be sent');

    assert.strictEqual(result.accessToken, 'access_granted');
  });

  it('aborts without redeeming the code when iss does not match the discovered issuer (RFC 9207)', async () => {
    const { tokens } = await runFlow({ code: 'auth_code_2', iss: 'https://attacker.example.com' });

    await assert.rejects(tokens, (error: Error) => {
      assert.ok(error.message.includes('issuer mismatch'), error.message);
      return true;
    });
    assert.strictEqual(tokenEndpoint.bodies.length, 0, 'authorization code must never be redeemed');
  });

  it('aborts without redeeming the code when the server advertises iss support but omits it', async () => {
    const { tokens } = await runFlow({ code: 'auth_code_3' }, { authorizationResponseIssSupported: true });

    await assert.rejects(tokens, (error: Error) => {
      assert.ok(error.message.includes("omitted 'iss'"), error.message);
      return true;
    });
    assert.strictEqual(tokenEndpoint.bodies.length, 0, 'authorization code must never be redeemed');
  });

  it('proceeds when a server that does not advertise iss support omits it', async () => {
    const { tokens } = await runFlow({ code: 'auth_code_4' });
    const result = await tokens;

    assert.strictEqual(result.accessToken, 'access_granted');
    assert.strictEqual(tokenEndpoint.bodies.length, 1);
  });

  it('sends the resource on a token refresh (RFC 8707)', async () => {
    const flow = new InteractiveOAuthFlow();
    const tokens = await flow.refreshTokens(tokenEndpoint.url, 'refresh_granted', 'client-id', 'client-secret', RESOURCE, true);

    assert.strictEqual(tokens.accessToken, 'access_granted');
    assert.strictEqual(tokenEndpoint.bodies.length, 1);
    const body = tokenEndpoint.bodies[0] as URLSearchParams;
    assert.strictEqual(body.get('resource'), RESOURCE);
    assert.strictEqual(body.get('grant_type'), 'refresh_token');
  });
});
