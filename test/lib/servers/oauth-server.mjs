/**
 * Self-contained OAuth authorization server plus a bearer-protected MCP endpoint, for sign-in tests.
 *
 * PURPOSE: drive @mcp-z/client through CIMD, DCR, or both, with real HTTP and no provider.
 * FEATURES:
 * - RFC 8414 / RFC 9728 metadata on 127.0.0.1 (port 0)
 * - `registration_endpoint` only when `dcr` is on, `client_id_metadata_document_supported` only when `cimd` is on
 * - CIMD: a `client_id` that is the configured document URL is accepted without any outbound fetch; the
 *   redirect_uri is checked against the document's `redirect_uris`, a loopback host matching at any port (RFC 8252 7.3)
 * - Authorization codes with PKCE (S256), client authentication by Basic header or body, refresh tokens
 * - `/mcp` answers 401 with a resource_metadata challenge until a token this server issued is presented
 * - `state: 'wrong' | 'missing'` corrupts the state of the authorization response; `resource` replaces the resource named in the RFC 9728 document;
 *   `issuer` replaces the issuer in the RFC 8414 metadata; `clientAuth: 'post'` accepts (and advertises) only client_secret_post;
 *   `noEndpoints: true` publishes registration but no authorization or token endpoint; `tokenRedirectTo` answers the token endpoint with a 307 to that URL
 * - `separateAuthServer: true` serves the authorization server on its own listener, so it can be down while the MCP endpoint answers (`closeAuthServer()`)
 * - `omitExpiresIn: true` leaves `expires_in` out of token responses; `redirectRegister(url)` answers the registration endpoint with a 307
 * - `sse: true` serves the same tools over SSE at `/sse` (and answers `/mcp` with 404) instead of Streamable HTTP
 * - `checkRedirectOnRegister: true` makes `/register` GET the origin of each `redirect_uris` entry and record `listening: true|false` beside the registration
 * - `calls.initialize` lists the `clientInfo` of every authenticated MCP `initialize` request
 * - `calls` records what each endpoint received; `forgetClients()` makes registered clients unknown (invalid_client);
 *   `revokeAll()` makes every issued access and refresh token unknown; `hangTokens(true)` leaves token requests unanswered
 */

import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** RFC 8252 7.3: an http loopback redirect matches on scheme, host and path at any port; everything else must be identical. */
function redirectAllowed(registered, requested) {
  if (registered === requested) return true;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK_HOSTS.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.port === '';
}

const random = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

/**
 * @param {{ dcr?: boolean, sse?: boolean, separateAuthServer?: boolean, omitExpiresIn?: boolean, state?: 'wrong' | 'missing', resource?: string, issuer?: string, clientAuth?: 'post', checkRedirectOnRegister?: boolean, noEndpoints?: boolean, tokenRedirectTo?: string, cimd?: { url: string, document: { redirect_uris: string[] } } }} config
 */
export async function startOAuthServer(config = {}) {
  const { dcr = false, sse = false, cimd } = config;
  let hangTokens = false;
  let stateMode = config.state;
  let tokenRedirectTo = config.tokenRedirectTo;
  let registerRedirectTo;
  /** @type {{ status: number, grant?: string } | undefined} */
  let tokenFailure;
  const app = express();
  app.use(express.json());

  let base = '';
  let asBase = '';
  const asApp = config.separateAuthServer ? express() : app;
  if (asApp !== app) asApp.use(express.json());
  const clients = new Map();
  const codes = new Map();
  const accessTokens = new Set();
  const refreshTokens = new Map();
  /** @type {{ register: number, initialize: { name?: string, version?: string }[], registrations: Record<string, unknown>[], authorize: { client_id?: string, redirect_uri?: string, resource?: string, scope?: string }[], token: { grant_type?: string, client_id?: string, resource?: string, hung?: boolean, redirected?: boolean, failed?: number }[] }} */
  const calls = { register: 0, registrations: [], authorize: [], token: [], initialize: [] };

  asApp.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: config.issuer ?? asBase,
      ...(config.noEndpoints ? {} : { authorization_endpoint: `${asBase}/authorize`, token_endpoint: `${asBase}/token` }),
      ...(dcr ? { registration_endpoint: `${asBase}/register` } : {}),
      ...(cimd ? { client_id_metadata_document_supported: true } : {}),
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: config.clientAuth === 'post' ? ['client_secret_post'] : ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: ['read'],
    });
  });

  app.get('/.well-known/oauth-protected-resource/:endpoint', (req, res) => {
    res.json({ resource: config.resource ?? `${base}/${req.params.endpoint}`, authorization_servers: [asBase] });
  });

  /** True when something answers HTTP at the origin of every redirect URI: the callback listener is up. */
  async function listeningAt(redirectUris) {
    for (const uri of redirectUris ?? []) {
      try {
        await fetch(`${new URL(uri).origin}/`);
      } catch {
        return false;
      }
    }
    return true;
  }

  asApp.post('/register', async (req, res) => {
    if (registerRedirectTo) {
      res.redirect(307, registerRedirectTo);
      return;
    }
    calls.register += 1;
    calls.registrations.push(config.checkRedirectOnRegister ? { ...req.body, listening: await listeningAt(req.body.redirect_uris) } : req.body);
    const clientId = random('client');
    const clientSecret = random('secret');
    clients.set(clientId, { clientSecret, redirectUris: req.body.redirect_uris ?? [] });
    res.status(201).json({ client_id: clientId, client_secret: clientSecret, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: req.body.redirect_uris, token_endpoint_auth_method: 'client_secret_basic' });
  });

  /** The redirect URIs a client_id may use, or undefined when the client is unknown. */
  function allowedRedirects(clientId) {
    if (clients.has(clientId)) return clients.get(clientId).redirectUris;
    if (cimd && clientId === cimd.url) return cimd.document.redirect_uris;
    return undefined;
  }

  asApp.get('/authorize', (req, res) => {
    const q = req.query;
    calls.authorize.push({ client_id: q.client_id, redirect_uri: q.redirect_uri, resource: q.resource, scope: q.scope });
    const registered = allowedRedirects(String(q.client_id));
    const redirectUri = String(q.redirect_uri ?? '');
    if (!registered || !registered.some((uri) => redirectAllowed(uri, redirectUri))) {
      res.status(400).send('invalid client or redirect_uri');
      return;
    }
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
      res.status(400).send('PKCE S256 required');
      return;
    }
    const code = random('code');
    codes.set(code, { clientId: String(q.client_id), redirectUri, challenge: String(q.code_challenge) });
    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    if (q.state && stateMode !== 'missing') location.searchParams.set('state', stateMode === 'wrong' ? 'not-the-state' : String(q.state));
    res.redirect(location.toString());
  });

  function authenticateClient(req) {
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
    let clientId = req.body.client_id;
    let secret = req.body.client_secret;
    if (basic && config.clientAuth !== 'post') {
      const [id, ...rest] = Buffer.from(basic[1], 'base64').toString().split(':');
      clientId = decodeURIComponent(id);
      secret = decodeURIComponent(rest.join(':'));
    }
    if (cimd && clientId === cimd.url) return clientId;
    const client = clients.get(clientId);
    return client && client.clientSecret === secret ? clientId : undefined;
  }

  asApp.post('/token', express.urlencoded({ extended: true }), (req, res) => {
    if (tokenRedirectTo) {
      calls.token.push({ grant_type: req.body.grant_type, redirected: true });
      res.redirect(307, tokenRedirectTo);
      return;
    }
    if (tokenFailure && (!tokenFailure.grant || tokenFailure.grant === req.body.grant_type)) {
      calls.token.push({ grant_type: req.body.grant_type, failed: tokenFailure.status });
      res.status(tokenFailure.status).json({ error: 'server_error' });
      return;
    }
    if (hangTokens) {
      calls.token.push({ grant_type: req.body.grant_type, hung: true });
      return;
    }
    calls.token.push({ grant_type: req.body.grant_type, client_id: authenticateClient(req) ?? req.body.client_id, resource: req.body.resource });
    const clientId = authenticateClient(req);
    if (!clientId) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    if (req.body.grant_type === 'authorization_code') {
      const entry = codes.get(req.body.code);
      codes.delete(req.body.code);
      const verifier = createHash('sha256')
        .update(String(req.body.code_verifier ?? ''))
        .digest('base64url');
      if (!entry || entry.clientId !== clientId || entry.redirectUri !== req.body.redirect_uri || entry.challenge !== verifier) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
    } else if (req.body.grant_type === 'refresh_token') {
      if (refreshTokens.get(req.body.refresh_token) !== clientId) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    const accessToken = random('access');
    const refreshToken = random('refresh');
    accessTokens.add(accessToken);
    refreshTokens.set(refreshToken, clientId);
    res.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', ...(config.omitExpiresIn ? {} : { expires_in: 3600 }) });
  });

  const createMcp = () => {
    const mcp = new McpServer({ name: 'oauth-server', version: '1.0.0' });
    mcp.registerTool('ping', { description: 'Answers pong', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    return mcp;
  };

  /** Answers 401 with a resource_metadata challenge unless the request carries a token this server issued. */
  const requireToken = (endpoint) => (req, res, next) => {
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (token && accessTokens.has(token)) return next();
    res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${endpoint}"`);
    res.status(401).json({ error: 'unauthorized' });
  };

  const recordInitialize = (body) => {
    if (body?.method === 'initialize') calls.initialize.push(body.params?.clientInfo);
  };

  if (sse) {
    const transports = new Map();
    app.get('/sse', requireToken('sse'), async (_req, res) => {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => transports.delete(transport.sessionId));
      await createMcp().connect(transport);
    });
    app.post('/messages', requireToken('sse'), async (req, res) => {
      recordInitialize(req.body);
      await transports.get(String(req.query.sessionId))?.handlePostMessage(req, res, req.body);
    });
  } else {
    app.post('/mcp', requireToken('mcp'), async (req, res) => {
      recordInitialize(req.body);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => transport.close());
      await createMcp().connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    app.get('/mcp', requireToken('mcp'), (_req, res) => {
      res.status(405).end();
    });
  }

  const httpServer = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.keepAliveTimeout = 0;
  });
  base = `http://127.0.0.1:${httpServer.address().port}`;
  let asServer = httpServer;
  if (asApp === app) {
    asBase = base;
  } else {
    asServer = await new Promise((resolve) => {
      const server = asApp.listen(0, '127.0.0.1', () => resolve(server));
      server.keepAliveTimeout = 0;
    });
    asBase = `http://127.0.0.1:${asServer.address().port}`;
  }
  const closeServer = (server) =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return {
    base,
    /** Where the authorization server is: `base` unless `separateAuthServer`. */
    authBase: asBase,
    mcpUrl: `${base}/${sse ? 'sse' : 'mcp'}`,
    calls,
    forgetClients: () => clients.clear(),
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    /** Makes the token endpoint answer `status` (for one grant type, or all); `undefined` ends it. */
    failTokens: (status, grant) => {
      tokenFailure = status === undefined ? undefined : { status, grant };
    },
    /** Answers the token endpoint with a 307 to `url` from now on; `undefined` ends it. */
    redirectTokens: (url) => {
      tokenRedirectTo = url;
    },
    /** Corrupts the state of later authorization responses: 'wrong', 'missing', or undefined for none. */
    corruptState: (mode) => {
      stateMode = mode;
    },
    /** Forgets issued access tokens only: refresh tokens stay valid. */
    revokeAccessTokens: () => accessTokens.clear(),
    /** Issues a sign-in to a registered client, as an earlier release's sign-in would hold. */
    issueTokens: (clientId) => {
      const accessToken = random('access');
      const refreshToken = random('refresh');
      accessTokens.add(accessToken);
      refreshTokens.set(refreshToken, clientId);
      return { accessToken, refreshToken };
    },
    hangTokens: (on) => {
      hangTokens = on;
    },
    /** Answers the registration endpoint with a 307 to `url` from now on; `undefined` ends it. */
    redirectRegister: (url) => {
      registerRedirectTo = url;
    },
    closeAuthServer: () => closeServer(asServer),
    close: async () => {
      await closeServer(httpServer);
      if (asServer !== httpServer) await closeServer(asServer);
    },
  };
}
