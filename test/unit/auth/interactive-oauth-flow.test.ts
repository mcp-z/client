/**
 * Unit tests for interactive-oauth-flow.ts
 * Drives the real loopback callback listener against a real token endpoint
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import type { Logger, OAuthFlowOptions } from '@mcp-z/client';
import { InteractiveOAuthFlow } from '@mcp-z/client';
import assert from 'assert';
import getPort from 'get-port';
import { listenOnFreePort } from '../../lib/listen-on-free-port.ts';

const ISSUER = 'https://issuer.example.com';
const RESOURCE = 'https://resource.example.com/mcp';

interface TokenEndpoint {
  url: string;
  bodies: URLSearchParams[];
  close: () => Promise<void>;
}

async function startTokenEndpoint(): Promise<TokenEndpoint> {
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

  const port = await listenOnFreePort(server, '127.0.0.1');

  return {
    url: `http://127.0.0.1:${port}/token`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The flow logs the authorization URL once the callback listener is bound, so awaiting it also sequences the callback below. `events` keeps the order of warnings and info lines. */
function createAuthorizeUrlRecorder(urlPrefix = 'http'): { logger: Logger; authorizeUrl: Promise<URL>; events: string[] } {
  let resolveUrl: (url: URL) => void;
  const authorizeUrl = new Promise<URL>((resolve) => {
    resolveUrl = resolve;
  });
  const events: string[] = [];
  const noop = () => {};

  return {
    logger: {
      info: (message: unknown) => {
        if (typeof message !== 'string') return;
        events.push(`info: ${message}`);
        if (message.startsWith(urlPrefix)) resolveUrl(new URL(message));
      },
      debug: noop,
      warn: (...args: unknown[]) => {
        events.push(`warn: ${args.join(' ')}`);
      },
      error: noop,
    },
    authorizeUrl,
    events,
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

  it('performAuthFlow without a port binds an assigned one and carries it in the redirect_uri', async () => {
    const recorder = createAuthorizeUrlRecorder();
    const flow = new InteractiveOAuthFlow();
    const done = flow.performAuthFlow('https://issuer.example.com/authorize', tokenEndpoint.url, 'client-id', 'client-secret', {
      issuer: ISSUER,
      resource: RESOURCE,
      pkce: true,
      headless: true,
      allowLoopback: true,
      timeout: 10000,
      logger: recorder.logger,
    });
    const authorizeUrl = await recorder.authorizeUrl;
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
    assert.ok(/^http:\/\/localhost:[1-9]\d*\/callback$/.test(redirectUri), redirectUri);

    await deliverCallback(redirectUri, { code: 'code_from_browser', iss: ISSUER });
    const tokens = await done;

    assert.strictEqual(tokens.accessToken, 'access_granted');
    assert.strictEqual(tokenEndpoint.bodies[0]?.get('redirect_uri'), redirectUri);
  });

  async function runFlow(callbackParams: Record<string, string>, overrides: Partial<OAuthFlowOptions> = {}, authorizationEndpoint = 'https://issuer.example.com/authorize', urlPrefix = 'http') {
    const port = await getPort({ host: 'localhost' });
    const redirectUri = `http://localhost:${port}/callback`;
    const recorder = createAuthorizeUrlRecorder(urlPrefix);

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
    const tokens = flow.performAuthFlow(authorizationEndpoint, tokenEndpoint.url, 'client-id', 'client-secret', options);
    // Callers assert on the rejection only after delivering the callback below.
    tokens.catch(() => {});

    // A flow that fails before logging the URL rejects here instead of leaving the test waiting.
    const authorizeUrl = await Promise.race([recorder.authorizeUrl, tokens.then(() => Promise.reject(new Error('flow finished before the authorization URL was logged')))]);
    await deliverCallback(redirectUri, callbackParams);

    return { authorizeUrl, tokens, events: recorder.events };
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

  it('warns and prints the URL when the browser will not open it, and still completes the flow', async () => {
    const { authorizeUrl, tokens, events } = await runFlow({ code: 'auth_code_5', iss: ISSUER }, { headless: false }, 'mcp-z-client-refused:authorize', 'mcp-z-client-refused:');
    const result = await tokens;

    const warning = events.findIndex((event) => event.startsWith('warn: Could not open the browser:'));
    const urlLine = events.indexOf(`info: ${authorizeUrl.toString()}`);
    assert.ok(warning >= 0, events.join('\n'));
    assert.ok(urlLine > warning, 'the URL line follows the warning');
    assert.strictEqual(events.filter((event) => event.startsWith('info: mcp-z-client-refused:')).length, 1, 'the URL is printed once');
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
