/**
 * DCR Authenticator
 * Signs in to MCP HTTP servers through the SDK's auth(): a client metadata document (CIMD) when the server accepts one, dynamic registration (DCR) otherwise
 */

import type Keyv from 'keyv';
import type { AuthCapabilities, TokenSet } from '../auth/types.ts';
import type { Logger } from '../utils/logger.ts';
import { SignIn } from './sign-in.ts';

/**
 * DcrAuthenticator configuration options
 */
export interface DcrAuthenticatorOptions {
  /** Custom Keyv store (for testing) - if not provided, uses the shared default <cwd>/.mcp-z/tokens.json */
  tokenStore?: Keyv;
  /** Headless mode (don't open browser) */
  headless?: boolean;
  /** Required redirect URI for OAuth callback */
  redirectUri: string;
  /** Optional logger for debug output (defaults to singleton logger) */
  logger?: Logger;
  /**
   * https URL of a client metadata document the application hosts, sent as the `client_id` to servers that accept one (CIMD).
   * There is no default: without it the client never offers a document and registers (DCR), so a server that offers only CIMD fails with the SDK's error.
   */
  clientMetadataUrl?: string;
  /** Name the client registers under (DCR). Without it the registration carries no `client_name`. */
  clientName?: string;
}

/**
 * DcrAuthenticator manages authentication for MCP HTTP servers.
 * It runs the SDK's auth() over the token store: registration (a client metadata document or DCR), the browser sign-in, and token refresh.
 */
export class DcrAuthenticator {
  private signIn: SignIn;

  constructor(options: DcrAuthenticatorOptions) {
    this.signIn = new SignIn(options);
  }

  /**
   * Ensure server is authenticated, signing in if needed
   * Returns a stored sign-in as it is unless it expires within 5 minutes; then it is refreshed, and a new sign-in is made when it cannot be
   *
   * @param mcpServerUrl - The MCP server's canonical URL, exactly as configured,
   *   with its path intact (`https://example.com/mcp`). Not a deployment root:
   *   the path is what identifies the resource an issued token is bound to.
   * @param capabilities - Auth capabilities from .well-known endpoint
   * @returns Valid token set ready to use
   *
   * @throws Error if authentication fails
   *
   * @example
   * const authenticator = new DcrAuthenticator({ redirectUri: 'http://127.0.0.1:3000/callback' });
   * const tokens = await authenticator.ensureAuthenticated(
   *   'https://example.com/mcp',
   *   capabilities
   * );
   */
  async ensureAuthenticated(mcpServerUrl: string, capabilities: AuthCapabilities, signal?: AbortSignal): Promise<TokenSet> {
    return this.signIn.ensureAuthenticated(mcpServerUrl, capabilities, signal);
  }

  /**
   * Deletes the stored sign-in for a server, across every issuer it was bound to: its tokens (both families earlier releases wrote) and its client registration.
   *
   * Takes the same `mcpServerUrl` that {@link DcrAuthenticator.ensureAuthenticated}
   * was given - keys are built from the configured URL, never from the discovered
   * RFC 8707 resource, precisely so this can find them without doing discovery.
   *
   * The token store must support iteration (see the README); a store that cannot list its keys deletes nothing.
   */
  async deleteTokens(mcpServerUrl: string): Promise<void> {
    return this.signIn.deleteTokens(mcpServerUrl);
  }
}
