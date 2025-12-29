/**
 * OAuth Authorization Flow Handler
 * Manages browser-based OAuth flows and token exchange with PKCE support
 */

import * as child_process from 'node:child_process';
import { logger as defaultLogger } from '../utils/logger.ts';
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
   *   { port, scopes: ['read', 'write'] }
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

      // Add resource parameter if specified (RFC 8707)
      if (options.resource) {
        authUrl.searchParams.set('resource', options.resource);
      }

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

      // Exchange authorization code for tokens (with PKCE verifier if used)
      const tokens = await this.exchangeCodeForTokens(tokenEndpoint, result.code, clientId, clientSecret, redirectUri, pkce?.codeVerifier);

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
   * Exchange authorization code for access and refresh tokens
   * @param codeVerifier - Optional PKCE code verifier (RFC 7636)
   */
  private async exchangeCodeForTokens(tokenEndpoint: string, code: string, clientId: string, clientSecret: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    // Add PKCE code verifier if provided (RFC 7636)
    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Connection: 'close',
      },
      body: params,
    });

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
   * Refresh access token using refresh token
   *
   * @param tokenEndpoint - OAuth token endpoint URL
   * @param refreshToken - Refresh token from previous token set
   * @param clientId - OAuth client ID
   * @param clientSecret - OAuth client secret
   * @returns New token set with refreshed access token
   *
   * @throws Error if refresh fails
   */
  async refreshTokens(tokenEndpoint: string, refreshToken: string, clientId: string, clientSecret: string): Promise<TokenSet> {
    const response = await fetch(tokenEndpoint, {
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
      }),
    });

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
