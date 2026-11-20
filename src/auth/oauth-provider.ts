/**
 * OAuthClientProvider over the token store, so the SDK's auth() can sign in.
 *
 * Tokens keep the {@link TokenSet} shape under `tokens:<issuer>:<server>`, the same entry earlier releases wrote, so their sign-ins are read and refreshed
 * and a release that predates this one can still read what is saved here. Client registrations are kept under `client:<issuer>:<server>`;
 * a registration an earlier release made lives in its token entry and is used until the server rejects it.
 */

import { randomBytes } from 'node:crypto';
import type { AuthorizationServerMetadata, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import type Keyv from 'keyv';
import type { Logger } from '../utils/logger.ts';
import { OAuthCallbackListener } from './oauth-callback-listener.ts';
import { presentAuthorizationUrl } from './present-authorization-url.ts';
import type { AuthCapabilities, CallbackResult, TokenSet } from './types.ts';

const HEADLESS_CALLBACK_TIMEOUT_MS = 60_000;
const CALLBACK_TIMEOUT_MS = 300_000;

/** The first request that failed during a sign-in attempt (network error, refusal, abort), kept so it is not mistaken for a reason to sign in again. */
export interface Failure {
  error?: unknown;
}

export interface StoreOAuthProviderOptions {
  store: Keyv;
  /** Issuer every stored credential is bound to (SEP-2352). */
  issuer: string;
  /** Identifies the server in store keys: its configured URL, normalized. */
  storeKey: string;
  redirectUrl: string;
  /** Name registered under (DCR); left out of the registration when unset. */
  clientName?: string;
  /** False once connected: a new sign-in then fails with UnauthorizedError instead of opening a browser nobody is watching. */
  interactive: boolean;
  /** Sent as `client_id` to a server that accepts client metadata documents. */
  clientMetadataUrl?: string;
  /** Discovery already done by the caller; auth() works from it instead of discovering again. */
  capabilities: AuthCapabilities;
  /** RFC 8707 resource indicator: what the server named in its RFC 9728 metadata, else the configured URL. */
  resource: string;
  headless: boolean;
  logger: Logger;
  signal?: AbortSignal;
  failure?: Failure;
}

export class StoreOAuthProvider implements OAuthClientProvider {
  private readonly options: StoreOAuthProviderOptions;
  private readonly tokenKey: string;
  private readonly legacyTokenKey: string;
  private readonly clientKey: string;
  private verifier?: string;
  private expectedState?: string;
  private listener?: OAuthCallbackListener;
  private callback?: Promise<CallbackResult>;
  /** Set when a non-interactive provider has had its credentials invalidated: nothing may be registered or asked any more. */
  private mustSignInAgain = false;

  constructor(options: StoreOAuthProviderOptions) {
    this.options = options;
    const suffix = `${options.issuer}:${options.storeKey}`;
    this.tokenKey = `tokens:${suffix}`;
    this.legacyTokenKey = `dcr-tokens:${suffix}`;
    this.clientKey = `client:${suffix}`;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadataUrl(): string | undefined {
    return this.options.clientMetadataUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...(this.options.clientName && { client_name: this.options.clientName }),
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      // The callback is always a loopback URI an authorization server rejects for a web client (SEP-837, RFC 8252).
      application_type: 'native',
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString('hex');
    return this.expectedState;
  }

  /** What the caller discovered, in the shape auth() reads, so it neither fetches metadata again nor trusts a second answer. */
  discoveryState(): OAuthDiscoveryState {
    const { capabilities, issuer, resource } = this.options;
    // The metadata as the server published it, so what the SDK reads (client authentication methods, scopes, PKCE methods) is what the server said.
    const metadata = {
      ...capabilities.authorizationServerMetadata,
      issuer,
      authorization_endpoint: capabilities.authorizationEndpoint,
      token_endpoint: capabilities.tokenEndpoint,
      response_types_supported: ['code'],
      ...(capabilities.registrationEndpoint && { registration_endpoint: capabilities.registrationEndpoint }),
      ...(capabilities.supportsCimd && { client_id_metadata_document_supported: true }),
      ...(capabilities.authorizationResponseIssSupported && { authorization_response_iss_parameter_supported: true }),
    } as AuthorizationServerMetadata;
    return { authorizationServerUrl: issuer, authorizationServerMetadata: metadata, resourceMetadata: { resource, authorization_servers: [issuer] } };
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    // Registering a client for a sign-in that cannot be made would leave an unused registration at the server.
    if (this.mustSignInAgain) throw new UnauthorizedError('Signing in again is needed; connect again to sign in');
    const stored = (await this.options.store.get(this.clientKey)) as StoredOAuthClientInformation | undefined;
    const signIn = await this.loadTokenSet();
    // A registered client is tied to the redirect URI it was registered with, and each sign-in binds a new port. So it can refresh the sign-in it belongs to, but a new authorization needs a new registration.
    const canRefresh = Boolean(signIn?.refreshToken);

    // A document URL the caller no longer uses is not this client's identity any more.
    if (stored && !(isDocumentUrl(stored.client_id) && stored.client_id !== this.options.clientMetadataUrl)) {
      // Once the authorization has started, the code is redeemed by the client that asked for it.
      if (this.verifier !== undefined || isDocumentUrl(stored.client_id) || (stored as { redirect_uris?: string[] }).redirect_uris?.includes(this.options.redirectUrl) || canRefresh) return stored;
    }

    if (signIn?.clientId && canRefresh) return { client_id: signIn.clientId, ...(signIn.clientSecret && { client_secret: signIn.clientSecret }), issuer: this.options.issuer };
    return undefined;
  }

  async saveClientInformation(information: StoredOAuthClientInformation): Promise<void> {
    await this.options.store.set(this.clientKey, information);
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const stored = await this.loadTokenSet();
    if (!stored) return undefined;
    return {
      access_token: stored.accessToken,
      token_type: 'Bearer',
      // A token whose expiry is unknown says nothing about it: the server's 401 is what tells.
      ...(Number.isFinite(stored.expiresAt) && { expires_in: Math.max(0, Math.round((stored.expiresAt - Date.now()) / 1000)) }),
      ...(stored.refreshToken && { refresh_token: stored.refreshToken }),
      ...(stored.scopes && { scope: stored.scopes.join(' ') }),
      issuer: this.options.issuer,
    } as StoredOAuthTokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const previous = await this.loadTokenSet();
    const client = await this.clientInformation();
    const tokenSet: TokenSet = {
      accessToken: tokens.access_token,
      // A refresh response that carries no new refresh token keeps the old one (RFC 6749 section 6).
      refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? '',
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : Number.NaN,
      issuer: this.options.issuer,
    };
    if (tokens.scope) tokenSet.scopes = tokens.scope.split(' ');
    if (client) {
      tokenSet.clientId = client.client_id;
      if (client.client_secret) tokenSet.clientSecret = client.client_secret;
    }
    await this.options.store.set(this.tokenKey, tokenSet);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE code verifier saved for this authorization');
    return this.verifier;
  }

  /** Binds the callback listener, then shows the user the URL; {@link awaitCallback} returns what the listener received. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // auth() answers a refresh that could not reach the server with a new authorization request. Nobody can complete that, and the stored sign-in stays as it is.
    if (this.options.failure?.error !== undefined) throw this.options.failure.error;
    if (!this.options.interactive) throw new UnauthorizedError('Signing in again is needed; connect again to sign in');
    const redirect = new URL(this.options.redirectUrl);
    const port = Number.parseInt(redirect.port, 10) || (redirect.protocol === 'https:' ? 443 : 80);
    const listener = new OAuthCallbackListener({ port, host: redirect.hostname.replace(/^\[|\]$/g, ''), logger: this.options.logger });
    this.listener = listener;
    try {
      await listener.start();
      // Registered before the URL is shown, so a callback cannot arrive unobserved.
      this.callback = listener.waitForCallback(this.options.headless ? HEADLESS_CALLBACK_TIMEOUT_MS : CALLBACK_TIMEOUT_MS, this.options.signal);
      this.callback.catch(() => {});
      await presentAuthorizationUrl(authorizationUrl.toString(), { headless: this.options.headless, logger: this.options.logger });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** The authorization response, once the user has signed in. Rejects when the response does not carry this authorization's `state`. */
  async awaitCallback(): Promise<CallbackResult> {
    if (!this.callback) throw new Error('No authorization is waiting for a callback');
    const result = await this.callback;
    if (result.state !== this.expectedState) throw new Error('Authorization response state mismatch - refusing to redeem the authorization code');
    return result;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (!this.options.interactive && (scope === 'all' || scope === 'client' || scope === 'tokens')) this.mustSignInAgain = true;
    if (scope === 'all' || scope === 'client') await this.options.store.delete(this.clientKey);
    if (scope === 'all' || scope === 'tokens') {
      await this.options.store.delete(this.tokenKey);
      await this.options.store.delete(this.legacyTokenKey);
    }
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }

  /** The stored sign-in, or undefined. One bound to another issuer is discarded (SEP-2352). `dcr-tokens` entries of earlier releases are read when `tokens` has none. */
  async loadTokenSet(): Promise<TokenSet | undefined> {
    const key = (await this.options.store.has(this.tokenKey)) ? this.tokenKey : this.legacyTokenKey;
    const stored = (await this.options.store.get(key)) as TokenSet | undefined;
    if (!stored) return undefined;
    if (stored.issuer === this.options.issuer) return stored;

    this.options.logger.debug('🔑 Stored credential is not bound to the discovered issuer, re-authorizing');
    await this.options.store.delete(key);
    return undefined;
  }

  /** Removes the stored sign-in, including the registration inside it. */
  async deleteTokenSet(): Promise<void> {
    await this.invalidateCredentials('tokens');
  }

  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    await listener?.stop();
  }
}

function isDocumentUrl(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === 'https:';
  } catch {
    return false;
  }
}
