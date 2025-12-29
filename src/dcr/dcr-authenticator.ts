/**
 * DCR Authenticator
 * Consolidates DCR and OAuth flow logic for MCP HTTP servers
 */

import path from 'node:path';
import * as fs from 'fs';
import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
import { InteractiveOAuthFlow } from '../auth/interactive-oauth-flow.ts';
import type { AuthCapabilities, TokenSet } from '../auth/types.ts';
import { logger as defaultLogger, type Logger } from '../utils/logger.ts';
import { DynamicClientRegistrar } from './dynamic-client-registrar.ts';

/**
 * DcrAuthenticator configuration options
 */
export interface DcrAuthenticatorOptions {
  /** Custom Keyv store (for testing) - if not provided, uses default ~/.mcpeasy/tokens.json */
  tokenStore?: Keyv;
  /** Headless mode (don't open browser) */
  headless?: boolean;
  /** Required redirect URI for OAuth callback */
  redirectUri: string;
  /** Optional logger for debug output (defaults to singleton logger) */
  logger?: Logger;
}

/**
 * Buffer time before token expiry to trigger proactive refresh (5 minutes)
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * DcrAuthenticator manages authentication for MCP HTTP servers
 * Handles DCR registration, OAuth flows, and token management
 */
export class DcrAuthenticator {
  private tokenStore: Keyv;
  private dcrClient: DynamicClientRegistrar;
  private oauthFlow: InteractiveOAuthFlow;
  private headless: boolean;
  private redirectUri: string;
  private logger: Logger;

  constructor(options: DcrAuthenticatorOptions) {
    if (options.tokenStore) {
      this.tokenStore = options.tokenStore;
    } else {
      // Default CLI store in .mcp-z directory (per-project)
      const storePath = path.join(process.cwd(), '.mcp-z', 'tokens.json');

      // Ensure directory exists before creating store
      fs.mkdirSync(path.dirname(storePath), { recursive: true });

      this.tokenStore = new Keyv({
        store: new KeyvFile({ filename: storePath }),
      });
    }
    this.dcrClient = new DynamicClientRegistrar();
    this.oauthFlow = new InteractiveOAuthFlow();
    this.headless = options.headless || false;
    this.redirectUri = options.redirectUri;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Detect if server is self-hosted DCR (vs external OAuth provider)
   * Self-hosted servers have their own OAuth endpoints and manage token storage
   */
  private async detectSelfHostedMode(baseUrl: string): Promise<boolean> {
    try {
      // Self-hosted DCR servers typically run their own OAuth server
      // Check if this is a self-hosted instance by testing OAuth metadata
      // For now, assume self-hosted if baseUrl matches common localhost patterns
      // TODO: Implement proper self-hosted detection logic
      return baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
    } catch (_error) {
      return false; // Assume external mode if detection fails
    }
  }

  /**
   * Ensure server is authenticated, performing DCR and OAuth if needed
   * Proactively refreshes tokens if they're within 5 minutes of expiry
   *
   * @param baseUrl - Base URL of the server (e.g., https://example.com)
   * @param capabilities - Auth capabilities from .well-known endpoint
   * @returns Valid token set ready to use
   *
   * @throws Error if authentication fails
   *
   * @example
   * const authenticator = new DcrAuthenticator({ redirectUri: 'http://localhost:3000/callback' });
   * const tokens = await authenticator.ensureAuthenticated(
   *   'https://example.com',
   *   capabilities
   * );
   */
  async ensureAuthenticated(baseUrl: string, capabilities: AuthCapabilities): Promise<TokenSet> {
    // Auto-detect server mode
    const isSelfHosted = await this.detectSelfHostedMode(baseUrl);

    if (isSelfHosted) {
      return this.ensureAuthenticatedSelfHosted(baseUrl, capabilities);
    }
    return this.ensureAuthenticatedExternal(baseUrl, capabilities);
  }

  /**
   * Handle authentication for self-hosted DCR servers
   * Self-hosted servers manage their own token storage via /oauth/verify
   */
  private async ensureAuthenticatedSelfHosted(baseUrl: string, capabilities: AuthCapabilities): Promise<TokenSet> {
    const dcrTokenKey = `dcr-tokens:${baseUrl}`;

    // 1. Check for existing DCR tokens (different from external tokens)
    let tokens = (await this.tokenStore.get(dcrTokenKey)) as TokenSet | undefined;

    if (tokens) {
      // 2. Verify token is still valid by calling /oauth/verify
      try {
        const verifyUrl = `${baseUrl}/oauth/verify`;
        const verifyResponse = await fetch(verifyUrl, {
          headers: { Authorization: `Bearer ${tokens.accessToken}`, Connection: 'close' },
        });

        if (verifyResponse.ok) {
          const verifyData = (await verifyResponse.json()) as { token?: string };
          if (verifyData.token === tokens.accessToken) {
            // Token is still valid with the self-hosted server
            return tokens;
          }
        }
      } catch (_error) {
        // Token verification failed - need to re-authenticate
      }

      // Token is expired or invalid
      await this.tokenStore.delete(dcrTokenKey);
      tokens = undefined;
    }

    // 3. No valid tokens - perform full DCR + OAuth flow
    if (!capabilities.registrationEndpoint || !capabilities.authorizationEndpoint || !capabilities.tokenEndpoint) {
      throw new Error('Server does not provide required OAuth endpoints');
    }

    this.logger.debug('🔐 No valid tokens found, starting self-hosted DCR authentication...');

    // Extract port from pre-resolved redirectUri
    const port = parseInt(new URL(this.redirectUri).port, 10) || (this.redirectUri.startsWith('https:') ? 443 : 80);

    // Register OAuth client via DCR
    this.logger.debug('📝 Registering OAuth client with self-hosted server...');
    const client = await this.dcrClient.registerClient(capabilities.registrationEndpoint, {
      redirectUri: this.redirectUri,
    });

    // Perform OAuth authorization flow with PKCE (RFC 7636)
    const flowOptions: { port: number; headless: boolean; scopes?: string[]; redirectUri: string; pkce: boolean; logger: Logger } = {
      port,
      headless: this.headless,
      redirectUri: this.redirectUri,
      pkce: true,
      logger: this.logger,
    };
    if (capabilities.scopes) {
      flowOptions.scopes = capabilities.scopes;
    }

    tokens = await this.oauthFlow.performAuthFlow(capabilities.authorizationEndpoint, capabilities.tokenEndpoint, client.clientId, client.clientSecret, flowOptions);

    // For self-hosted mode, verify the token works with /oauth/verify immediately
    try {
      const verifyUrl = `${baseUrl}/oauth/verify`;
      const verifyResponse = await fetch(verifyUrl, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Connection: 'close' },
      });

      if (!verifyResponse.ok) {
        throw new Error(`DCR token verification failed after authentication: ${verifyResponse.status}`);
      }

      const verifyData = (await verifyResponse.json()) as { token?: string };
      if (verifyData.token !== tokens.accessToken) {
        throw new Error('DCR server returned different token in verification');
      }

      this.logger.debug('✅ DCR token verified with self-hosted server');
    } catch (error) {
      this.logger.error('❌ DCR token verification failed:', error instanceof Error ? error.message : String(error));
      throw new Error('Self-hosted DCR authentication completed but token verification failed');
    }

    // Save tokens for future use
    await this.tokenStore.set(dcrTokenKey, tokens);
    this.logger.debug('✅ Self-hosted DCR authentication successful, tokens saved');

    return tokens;
  }

  /**
   * Handle authentication for external OAuth providers (original implementation)
   */
  private async ensureAuthenticatedExternal(baseUrl: string, capabilities: AuthCapabilities): Promise<TokenSet> {
    const tokenKey = `tokens:${baseUrl}`;

    // 1. Check for existing tokens
    let tokens = (await this.tokenStore.get(tokenKey)) as TokenSet | undefined;

    if (tokens) {
      // 2. Proactive refresh if token expires within 5 minutes
      if (tokens.expiresAt < Date.now() + REFRESH_BUFFER_MS) {
        this.logger.debug('🔄 Refreshing access token...');

        try {
          tokens = await this.refreshTokens(tokens, capabilities.tokenEndpoint);
          await this.tokenStore.set(tokenKey, tokens);
          this.logger.debug('✅ Token refreshed successfully');
        } catch (_error) {
          // Refresh failed - clear tokens and re-authenticate
          this.logger.warn('⚠️  Token refresh failed, re-authenticating...');
          await this.tokenStore.delete(tokenKey);
          tokens = undefined;
        }
      }

      if (tokens) {
        return tokens;
      }
    }

    // 3. No valid tokens - perform DCR + OAuth flow
    if (!capabilities.registrationEndpoint || !capabilities.authorizationEndpoint || !capabilities.tokenEndpoint) {
      throw new Error('Server does not provide required OAuth endpoints');
    }

    this.logger.debug('🔐 No valid tokens found, starting external OAuth authentication...');

    // Extract port from pre-resolved redirectUri
    const port = parseInt(new URL(this.redirectUri).port, 10) || (this.redirectUri.startsWith('https:') ? 443 : 80);

    // Register OAuth client via DCR
    this.logger.debug('📝 Registering OAuth client...');
    const client = await this.dcrClient.registerClient(capabilities.registrationEndpoint, {
      redirectUri: this.redirectUri,
    });

    // Perform OAuth authorization flow with PKCE (RFC 7636)
    const flowOptions: { port: number; headless: boolean; scopes?: string[]; redirectUri: string; pkce: boolean; logger: Logger } = {
      port,
      headless: this.headless,
      redirectUri: this.redirectUri,
      pkce: true,
      logger: this.logger,
    };
    if (capabilities.scopes) {
      flowOptions.scopes = capabilities.scopes;
    }

    tokens = await this.oauthFlow.performAuthFlow(capabilities.authorizationEndpoint, capabilities.tokenEndpoint, client.clientId, client.clientSecret, flowOptions);

    // Save tokens for future use
    await this.tokenStore.set(tokenKey, tokens);
    this.logger.debug('✅ Authentication successful, tokens saved');

    return tokens;
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshTokens(tokens: TokenSet, tokenEndpoint?: string): Promise<TokenSet> {
    if (!tokenEndpoint) {
      throw new Error('Token endpoint not available for refresh');
    }

    if (!tokens.refreshToken) {
      throw new Error('No refresh token available');
    }

    if (!tokens.clientId || !tokens.clientSecret) {
      throw new Error('Client credentials not available for refresh');
    }

    return await this.oauthFlow.refreshTokens(tokenEndpoint, tokens.refreshToken, tokens.clientId, tokens.clientSecret);
  }

  /**
   * Delete stored tokens for a server
   */
  async deleteTokens(baseUrl: string): Promise<void> {
    const tokenKey = `tokens:${baseUrl}`;
    await this.tokenStore.delete(tokenKey);
    this.logger.debug(`🗑️  Deleted tokens for ${baseUrl}`);
  }
}
