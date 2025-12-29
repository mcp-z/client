/**
 * Shared types for OAuth and DCR authentication
 */

/**
 * OAuth callback result from authorization server
 */
export interface CallbackResult {
  /** Authorization code from OAuth server */
  code: string;
  /** State parameter for CSRF protection */
  state?: string;
}

/**
 * PKCE (Proof Key for Code Exchange) parameters (RFC 7636)
 * Used to secure OAuth 2.0 authorization code flow for public clients
 */
export interface PkceParams {
  /** Code verifier - cryptographically random string (43-128 characters) */
  codeVerifier: string;
  /** Code challenge - derived from code verifier using challenge method */
  codeChallenge: string;
  /** Code challenge method - S256 (SHA-256) or plain */
  codeChallengeMethod: 'S256' | 'plain';
}

/**
 * OAuth token set with access and refresh tokens
 */
export interface TokenSet {
  /** Access token for API requests */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken: string;
  /** Timestamp when access token expires (milliseconds since epoch) */
  expiresAt: number;
  /** Scopes granted for this token set */
  scopes?: string[];
  /** Client ID used for DCR registration (stored for future use) */
  clientId?: string;
  /** Client secret used for DCR registration (stored for future use) */
  clientSecret?: string;
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Response from .well-known/oauth-protected-resource endpoint
 */
export interface ProtectedResourceMetadata {
  /** The protected resource identifier */
  resource: string;
  /** List of authorization server URLs that can issue tokens for this resource */
  authorization_servers: string[];
  /** Optional list of scopes supported by this resource */
  scopes_supported?: string[];
  /** Optional list of bearer token methods supported (header, query, body) */
  bearer_methods_supported?: string[];
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * Response from .well-known/oauth-authorization-server endpoint
 */
export interface AuthorizationServerMetadata {
  /** The authorization server's issuer identifier */
  issuer?: string;
  /** URL of the authorization endpoint */
  authorization_endpoint?: string;
  /** URL of the token endpoint */
  token_endpoint?: string;
  /** URL of the client registration endpoint (DCR - RFC 7591) */
  registration_endpoint?: string;
  /** URL of the token introspection endpoint */
  introspection_endpoint?: string;
  /** List of OAuth scopes supported by the authorization server */
  scopes_supported?: string[];
  /** Response types supported (code, token, etc.) */
  response_types_supported?: string[];
  /** Grant types supported (authorization_code, refresh_token, etc.) */
  grant_types_supported?: string[];
  /** Token endpoint authentication methods supported */
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * OAuth server capabilities discovered from .well-known endpoint
 */
export interface AuthCapabilities {
  /** Whether the server supports Dynamic Client Registration (RFC 7591) */
  supportsDcr: boolean;
  /** DCR client registration endpoint */
  registrationEndpoint?: string;
  /** OAuth authorization endpoint */
  authorizationEndpoint?: string;
  /** OAuth token endpoint */
  tokenEndpoint?: string;
  /** Token introspection endpoint */
  introspectionEndpoint?: string;
  /** Supported OAuth scopes */
  scopes?: string[];
}

/**
 * Client credentials from DCR registration
 */
export interface ClientCredentials {
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Timestamp when client was registered */
  issuedAt?: number;
}

/**
 * Options for DCR client registration
 */
export interface DcrRegistrationOptions {
  /** Client name to register */
  clientName?: string;
  /** Redirect URI for OAuth callback */
  redirectUri?: string;
}

/**
 * Options for OAuth authorization flow
 */
export interface OAuthFlowOptions {
  /** Port for OAuth callback listener (required - use get-port to find available port) */
  port: number;
  /** Redirect URI for OAuth callback (optional - will be built from port if not provided) */
  redirectUri?: string;
  /** OAuth scopes to request */
  scopes?: string[];
  /** Resource parameter (RFC 8707) - target resource server identifier */
  resource?: string;
  /** Enable PKCE (RFC 7636) - recommended for all clients, required for public clients */
  pkce?: boolean;
  /** Headless mode (don't open browser) */
  headless?: boolean;
  /** Timeout for callback (milliseconds) */
  timeout?: number;
  /** Optional logger for debug output (defaults to singleton logger) */
  logger?: import('../utils/logger.ts').Logger;
}
