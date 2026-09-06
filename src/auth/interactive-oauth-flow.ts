/**
 * OAuth Authorization Flow Handler
 * Manages browser-based OAuth flows and token exchange with PKCE support
 */

import * as child_process from 'node:child_process';
import { logger as defaultLogger, type Logger } from '../utils/logger.ts';
import { discoveryFetch } from './discovery-fetch.ts';
import { OAuthCallbackListener } from './oauth-callback-listener.ts';
import { generatePkce } from './pkce.ts';
import type { OAuthFlowOptions, PkceParams, TokenSet } from './types.ts';

/**
 * OAuth token response from token endpoint
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/**
 * InteractiveOAuthFlow manages the complete OAuth authorization code flow
 */
export class InteractiveOAuthFlow {
  /**
   * Perform OAuth authorization code flow
   *
   * @param authorizationEndpoint - OAuth authorization endpoint URL
   * @param tokenEndpoint - OAuth token endpoint URL
   * @param clientId - OAuth client ID
   * @param clientSecret - OAuth client secret
   * @param options - Flow options (port is required - use get-port to find available port)
   * @returns Token set with access and refresh tokens
   *
   * @throws Error if flow fails or times out
   *
   * @example
   * import getPort from 'get-port';
   *
   * const flow = new InteractiveOAuthFlow();
   * const port = await getPort();
   * const tokens = await flow.performAuthFlow(
   *   'https://example.com/oauth/authorize',
   *   'https://example.com/oauth/token',
   *   'client-id',
   *   'client-secret',
   *   { port, issuer: 'https://example.com', resource: 'https://example.com/mcp', scopes: ['read', 'write'] }
   * );
   */
  async performAuthFlow(authorizationEndpoint: string, tokenEndpoint: string, clientId: string, clientSecret: string, options: OAuthFlowOptions): Promise<TokenSet> {
    const logger = options.logger ?? defaultLogger;
    const callbackListener = new OAuthCallbackListener({ port: options.port, logger });

    // Generate PKCE parameters if requested (RFC 7636)
    let pkce: PkceParams | undefined;
    if (options.pkce) {
      logger.debug('🔐 Generating PKCE parameters...');
      pkce = await generatePkce();
    }

    try {
      // Start callback server
      await callbackListener.start();

      // Build redirect URI
      const redirectUri = options.redirectUri || `http://localhost:${options.port}/callback`;

      // Build authorization URL
      const authUrl = new URL(authorizationEndpoint);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');

      if (options.scopes && options.scopes.length > 0) {
        authUrl.searchParams.set('scope', options.scopes.join(' '));
      }

      // Audience-bind the request to the resource server (RFC 8707)
      authUrl.searchParams.set('resource', options.resource);

      // Add PKCE parameters if generated (RFC 7636)
      if (pkce) {
        authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
        authUrl.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
      }

      // Open browser or print URL for headless mode
      if (options.headless) {
        logger.info('🔗 Please visit this URL to authorize:');
        logger.info(authUrl.toString());
        logger.info('Waiting for callback...');
      } else {
        logger.debug('🌐 Opening browser for OAuth authorization...');
        // Try to open browser (requires 'open' package or native command)
        await this.openBrowser(authUrl.toString());
      }

      // Wait for callback with timeout
      const timeout = options.timeout || (options.headless ? 60000 : 300000);
      const result = await callbackListener.waitForCallback(timeout);

      this.assertResponseIssuer(result.iss, options, logger);

      // Exchange authorization code for tokens (with PKCE verifier if used)
      const tokens = await this.exchangeCodeForTokens(tokenEndpoint, result.code, clientId, clientSecret, redirectUri, options.resource, options.allowLoopback ?? false, pkce?.codeVerifier);

      return tokens;
    } catch (error) {
      logger.error('❌ OAuth flow failed:', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      // Always close callback server
      await callbackListener.stop();
    }
  }

  /**
   * Rejects an authorization response that was not minted by the issuer
   * discovered before the flow started (RFC 9207 authorization-server mix-up).
   */
  private assertResponseIssuer(iss: string | undefined, options: OAuthFlowOptions, logger: Logger): void {
    if (iss !== undefined) {
      if (iss !== options.issuer) {
        throw new Error(`Authorization response issuer mismatch: got '${iss}', expected '${options.issuer}' - refusing to redeem the authorization code`);
      }
      return;
    }

    if (options.authorizationResponseIssSupported) {
      throw new Error(`Authorization server '${options.issuer}' advertises authorization_response_iss_parameter_supported but omitted 'iss' - refusing to redeem the authorization code`);
    }

    logger.debug(`⚠️  Authorization response carried no 'iss' and '${options.issuer}' does not advertise support for it (RFC 9207)`);
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   * @param resource - Canonical resource server URI, audience-binding the token (RFC 8707).
   * @param allowLoopback - Loopback trust grant computed by the caller from the server it is actually talking to, never from `tokenEndpoint`.
   * @param codeVerifier - Optional PKCE code verifier (RFC 7636).
   */
  private async exchangeCodeForTokens(tokenEndpoint: string, code: string, clientId: string, clientSecret: string, redirectUri: string, resource: string, allowLoopback: boolean, codeVerifier?: string): Promise<TokenSet> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      resource,
    });

    // Add PKCE code verifier if provided (RFC 7636)
    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    // tokenEndpoint is remote-controlled discovery data; discoveryFetch blocks
    // a private/internal target before the client secret is sent to it.
    const response = await discoveryFetch(
      tokenEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Connection: 'close',
        },
        body: params,
      },
      'token endpoint',
      { allowLoopback }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as TokenResponse;

    if (!data.access_token) {
      throw new Error('Token response missing access_token');
    }

    const tokenSet: TokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + data.expires_in * 1000,
      clientId,
      clientSecret,
    };

    if (data.scope) {
      tokenSet.scopes = data.scope.split(' ');
    }

    return tokenSet;
  }

  /**
   * Refreshes an access token using a refresh token.
   * @param tokenEndpoint - OAuth token endpoint URL.
   * @param refreshToken - Refresh token from a previous token set.
   * @param clientId - OAuth client ID.
   * @param clientSecret - OAuth client secret.
   * @param resource - Canonical resource server URI, audience-binding the token (RFC 8707).
   * @param allowLoopback - Loopback trust grant computed by the caller from the server it is actually talking to, never from `tokenEndpoint`. Defaults to `false`.
   * @returns New token set with a refreshed access token.
   * @throws Error if refresh fails.
   */
  async refreshTokens(tokenEndpoint: string, refreshToken: string, clientId: string, clientSecret: string, resource: string, allowLoopback = false): Promise<TokenSet> {
    // See exchangeCodeForTokens - tokenEndpoint is remote-controlled discovery data.
    const response = await discoveryFetch(
      tokenEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Connection: 'close',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          resource,
        }),
      },
      'token endpoint',
      { allowLoopback }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as TokenResponse;

    if (!data.access_token) {
      throw new Error('Token refresh response missing access_token');
    }

    const tokenSet: TokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Reuse old refresh token if not provided
      expiresAt: Date.now() + data.expires_in * 1000,
      clientId,
      clientSecret,
    };

    if (data.scope) {
      tokenSet.scopes = data.scope.split(' ');
    }

    return tokenSet;
  }

  /**
   * Open browser to authorization URL
   * Uses platform-specific command to open default browser
   */
  private async openBrowser(url: string): Promise<void> {
    // Determine platform-specific command
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', url];
    } else {
      // Linux and others
      command = 'xdg-open';
      args = [url];
    }

    // Spawn browser process
    const child = child_process.spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
  }
}
