/**
 * Sign-in to MCP HTTP servers through the SDK's auth(): a client metadata document (CIMD) when the server accepts one, dynamic registration (DCR) otherwise.
 * Internal: DcrAuthenticator is the public face, and connect-client uses this directly to give the transports their authProvider.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AuthProvider, auth, type FetchLike, UnauthorizedError, validateClientMetadataUrl } from '@modelcontextprotocol/client';
import type Keyv from 'keyv';
import createStore, { migrateKeyv5Keys } from 'keyv-registry';
import { discoveryFetch, isLoopbackUrl } from '../auth/discovery-fetch.ts';
import type { Failure } from '../auth/oauth-provider.ts';
import { StoreOAuthProvider } from '../auth/oauth-provider.ts';
import type { AuthCapabilities, TokenSet } from '../auth/types.ts';
import { DEFAULT_STORE_DIR, DEFAULT_STORE_FILE, SHARED_FILE_PROTOCOL } from '../constants.ts';
import { normalizeUrl } from '../lib/url-utils.ts';
import { logger as defaultLogger, type Logger } from '../utils/logger.ts';
import type { DcrAuthenticatorOptions } from './dcr-authenticator.ts';

/**
 * Buffer time before token expiry to trigger proactive refresh (5 minutes)
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** True only when the token's expiry is known and near. A token stored without one (2.5.x kept `null`) is used until the server answers 401. */
function isExpiring(tokens: TokenSet): boolean {
  return Number.isFinite(tokens.expiresAt) && tokens.expiresAt < Date.now() + REFRESH_BUFFER_MS;
}

/** Raised when a credential cannot be bound to, or looked up by, an issuer. */
class CredentialBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialBindingError';
  }
}

/**
 * The issuer credentials are keyed by, so they can never be presented to a
 * different authorization server even when the resource keeps its URL (SEP-2352).
 */
function requireIssuer(capabilities: AuthCapabilities): string {
  if (!capabilities.issuer) {
    throw new CredentialBindingError('Authorization server metadata has no issuer - credentials cannot be bound to an authorization server (RFC 8414 requires issuer)');
  }
  return capabilities.issuer;
}

/**
 * SignIn manages authentication for MCP HTTP servers.
 * It runs the SDK's auth() over the token store: registration (a client metadata document or DCR), the browser sign-in, and token refresh.
 */
interface Started {
  provider: StoreOAuthProvider;
  options: Parameters<typeof auth>[1];
  signal?: AbortSignal;
  result: 'AUTHORIZED' | 'REDIRECT';
}

export class SignIn {
  private tokenStore!: Keyv;
  private headless: boolean;
  private redirectUri: string;
  private clientMetadataUrl?: string;
  private clientName?: string;
  /** True while a connect is under way, the only time a transport may start a browser sign-in. */
  connecting = false;
  private logger: Logger;
  /** Set only for the default store: its path, opened on first use. */
  private defaultStorePath?: string;
  private defaultStoreReady?: Promise<void>;
  /** A sign-in whose browser step has started on behalf of a transport. */
  private pending?: Started;

  constructor(options: DcrAuthenticatorOptions) {
    if (options.tokenStore) {
      this.tokenStore = options.tokenStore;
    } else {
      this.defaultStorePath = path.join(process.cwd(), DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
    }
    this.headless = options.headless || false;
    this.redirectUri = options.redirectUri;
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.clientName = options.clientName;
    validateClientMetadataUrl(this.clientMetadataUrl);
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Opens the default store, shared with other processes through a locked file, and moves sign-ins saved by keyv 5 once.
   * A failure is not cached, so the next call retries.
   */
  private async ready(): Promise<void> {
    const storePath = this.defaultStorePath;
    if (!storePath) return;
    this.defaultStoreReady ??= this.openDefaultStore(storePath).catch((error) => {
      this.defaultStoreReady = undefined;
      throw error;
    });
    await this.defaultStoreReady;
  }

  private async openDefaultStore(storePath: string): Promise<void> {
    this.tokenStore = await createStore(pathToFileURL(storePath).href.replace(/^file:/, SHARED_FILE_PROTOCOL));
    try {
      const moved = await migrateKeyv5Keys(this.tokenStore);
      if (moved > 0) this.logger.debug(`Moved ${moved} saved sign-in entries to the keyv 6 format`);
    } catch (error) {
      throw new Error('Moving saved sign-ins to the keyv 6 format failed', { cause: error });
    }
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
    throwIfAborted(signal);
    await this.ready();
    const _issuer = requireIssuer(capabilities);
    const stored = await this.newProvider(mcpServerUrl, capabilities, signal).loadTokenSet();
    if (stored && !isExpiring(stored)) return stored;
    if (stored && !stored.refreshToken) {
      // An expired sign-in that cannot be refreshed also holds a registration whose redirect URI the new authorization would not match.
      await this.newProvider(mcpServerUrl, capabilities, signal).deleteTokenSet();
    }

    this.logger.debug('🔐 Signing in...');
    const tokens = await this.authorize(mcpServerUrl, capabilities, signal);
    this.logger.debug('✅ Authentication successful, tokens saved');
    return tokens;
  }

  /**
   * What the transports use as their `authProvider`: the stored token on every request and, when the server answers 401, a refresh before the request is retried once.
   * When a new sign-in is needed the browser step starts and the transport fails with UnauthorizedError, the SDK's sequence for it; the caller then runs
   * {@link SignIn.completePending} and connects again. The SDK's own provider adapter would run auth() through the transport's plain fetch, bypassing the SSRF guard.
   */
  authProvider(mcpServerUrl: string, capabilities: AuthCapabilities, signal?: AbortSignal): AuthProvider {
    return {
      token: async () => (await this.newProvider(mcpServerUrl, capabilities, signal).tokens())?.access_token,
      onUnauthorized: async () => {
        this.logger.debug('🔐 Server answered 401, refreshing or signing in again...');
        // Once connected, a 401 may refresh the token but never opens a browser: nobody is waiting to finish that sign-in.
        const started = await this.start(mcpServerUrl, capabilities, signal, this.connecting);
        if (started.result === 'AUTHORIZED') {
          await started.provider.close();
          return;
        }
        await this.discardPending();
        this.pending = started;
        throw new UnauthorizedError('Signing in again');
      },
    };
  }

  /** Finishes a sign-in that {@link SignIn.authProvider} started. False when none is waiting. */
  async completePending(): Promise<boolean> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return false;
    await this.finish(pending);
    return true;
  }

  /** Ends a sign-in nobody is going to complete, closing its callback listener. */
  async discardPending(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    await pending?.provider.close();
  }

  private newProvider(mcpServerUrl: string, capabilities: AuthCapabilities, signal?: AbortSignal, failure?: Failure, interactive = true): StoreOAuthProvider {
    const storeKey = normalizeUrl(mcpServerUrl);
    return new StoreOAuthProvider({
      store: this.tokenStore,
      issuer: requireIssuer(capabilities),
      storeKey,
      redirectUrl: this.redirectUri,
      clientMetadataUrl: this.clientMetadataUrl,
      clientName: this.clientName,
      interactive,
      capabilities,
      // The resource server names itself in its RFC 9728 metadata, and that name wins. Without it the configured URL, path included, stands in.
      resource: capabilities.resource ?? storeKey,
      headless: this.headless,
      logger: this.logger,
      signal,
      failure,
    });
  }

  /** Refreshes the stored sign-in or makes a new one, and returns what is stored afterwards. */
  private async authorize(mcpServerUrl: string, capabilities: AuthCapabilities, signal?: AbortSignal): Promise<TokenSet> {
    return this.finish(await this.start(mcpServerUrl, capabilities, signal));
  }

  /** Runs auth() up to the browser step: AUTHORIZED when a refresh was enough, REDIRECT when the user has to sign in. */
  private async start(mcpServerUrl: string, capabilities: AuthCapabilities, signal?: AbortSignal, interactive = true): Promise<Started> {
    if (!capabilities.authorizationEndpoint || !capabilities.tokenEndpoint) {
      throw new Error('Server does not provide required OAuth endpoints');
    }

    const failure: Failure = {};
    const provider = this.newProvider(mcpServerUrl, capabilities, signal, failure, interactive);
    // Loopback trust for every fetch below is computed from the server we're talking to, never from capabilities' endpoints (see discovery-fetch.ts).
    const options = { serverUrl: mcpServerUrl, fetchFn: guardedFetch(isLoopbackUrl(mcpServerUrl), signal, failure), ...(capabilities.scopes && { scope: capabilities.scopes.join(' ') }) };
    try {
      return { provider, options, signal, result: await auth(provider, options) };
    } catch (error) {
      await provider.close();
      throwIfAborted(signal);
      this.logger.error('❌ Sign-in failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Waits for the user's sign-in if there is one to wait for, redeems it, and returns what is stored. */
  private async finish(started: Started): Promise<TokenSet> {
    const { provider, options, signal } = started;
    try {
      if (started.result === 'REDIRECT') {
        const callback = await provider.awaitCallback();
        await auth(provider, { ...options, authorizationCode: callback.code, ...(callback.iss && { iss: callback.iss }) });
      }
    } catch (error) {
      throwIfAborted(signal);
      this.logger.error('❌ Sign-in failed:', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await provider.close();
    }

    const tokens = await provider.loadTokenSet();
    if (!tokens) throw new Error('Sign-in finished but no tokens were saved');
    return tokens;
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
    const suffix = `:${normalizeUrl(mcpServerUrl)}`;
    await this.ready();

    for await (const [key] of this.tokenStore.iterator()) {
      if (typeof key === 'string' && (key.startsWith('tokens:') || key.startsWith('dcr-tokens:') || key.startsWith('client:')) && key.endsWith(suffix)) {
        await this.tokenStore.delete(key);
      }
    }
    this.logger.debug(`🗑️  Deleted tokens for ${mcpServerUrl}`);
  }
}

/** Every request auth() makes goes through the SSRF guard, with the caller's cancellation. A request that fails is remembered, see {@link Failure}. */
function guardedFetch(allowLoopback: boolean, signal: AbortSignal | undefined, failure: Failure): FetchLike {
  return async (url, init) => {
    try {
      const response = await discoveryFetch(String(url), { ...init, signal: combineSignals(init?.signal, signal) }, 'authorization server', { allowLoopback });
      // The server could not answer; that says nothing about the credentials.
      if (response.status >= 500) failure.error ??= new Error(`Authorization server answered HTTP ${response.status}`);
      return response;
    } catch (error) {
      failure.error ??= error;
      throw error;
    }
  };
}

function combineSignals(a?: AbortSignal | null, b?: AbortSignal): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Authentication was cancelled');
}
