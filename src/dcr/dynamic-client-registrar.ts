/**
 * Dynamic Client Registration (DCR) Client
 * Implements RFC 7591 for OAuth client registration
 */

import { discoveryFetch } from '../auth/discovery-fetch.ts';
import type { ClientCredentials, DcrRegistrationOptions } from '../auth/types.ts';

/** DCR Registration Request (RFC 7591) */
interface DcrRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  application_type?: string;
}

/** DCR Registration Response (RFC 7591) */
interface DcrRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/** Handles Dynamic Client Registration with OAuth servers. */
export class DynamicClientRegistrar {
  /**
   * Registers a new OAuth client with the authorization server (RFC 7591).
   *
   * @param registrationEndpoint - Often sourced from remote-controlled AS metadata; pass `options.allowLoopback` explicitly. Defaults to `false`.
   * @param options - Registration options (redirect URI, client name, loopback trust).
   * @returns Client credentials (client ID and secret).
   * @throws Error if registration fails or the server returns an error.
   */
  async registerClient(registrationEndpoint: string, options: DcrRegistrationOptions): Promise<ClientCredentials> {
    const requestBody: DcrRegistrationRequest = {
      client_name: options.clientName || '@mcp-z/client',
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      // The callback listener always binds an OS-assigned loopback port, so the
      // redirect URI is one an authorization server rejects for a web client (SEP-837, RFC 8252).
      application_type: 'native',
    };

    // registrationEndpoint is remote-controlled discovery data; allowLoopback
    // must come from the caller's own trust, never from registrationEndpoint.
    const response = await discoveryFetch(
      registrationEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify(requestBody),
      },
      'registration endpoint',
      { allowLoopback: options.allowLoopback ?? false }
    );

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
