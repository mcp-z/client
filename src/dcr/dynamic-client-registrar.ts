/**
 * Dynamic Client Registration (DCR) Client
 * Implements RFC 7591 for OAuth client registration
 */

import type { ClientCredentials, DcrRegistrationOptions } from '../auth/types.ts';

/**
 * DCR Registration Request (RFC 7591)
 */
interface DcrRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

/**
 * DCR Registration Response (RFC 7591)
 */
interface DcrRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/**
 * DynamicClientRegistrar handles Dynamic Client Registration with OAuth servers
 */
export class DynamicClientRegistrar {
  /**
   * Register a new OAuth client with the authorization server
   *
   * @param registrationEndpoint - DCR registration endpoint URL
   * @param options - Registration options (client name, redirect URI)
   * @returns Client credentials (client ID and secret)
   *
   * @throws Error if registration fails or server returns error
   *
   * @example
   * const registrar = new DynamicClientRegistrar();
   * const creds = await registrar.registerClient(
   *   'https://example.com/oauth/register',
   *   { clientName: '@mcp-z/client', redirectUri: 'http://localhost:3000/callback' }
   * );
   * console.log('Client ID:', creds.clientId);
   */
  async registerClient(registrationEndpoint: string, options: DcrRegistrationOptions = {}): Promise<ClientCredentials> {
    const requestBody: DcrRegistrationRequest = {
      client_name: options.clientName || '@mcp-z/client',
      redirect_uris: options.redirectUri ? [options.redirectUri] : ['http://localhost:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    };

    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Connection: 'close',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DCR registration failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as DcrRegistrationResponse;

    if (!data.client_id) {
      throw new Error('DCR registration response missing client_id');
    }

    const credentials: ClientCredentials = {
      clientId: data.client_id,
      clientSecret: data.client_secret || '',
    };

    if (data.client_id_issued_at) {
      credentials.issuedAt = data.client_id_issued_at;
    }

    return credentials;
  }
}
