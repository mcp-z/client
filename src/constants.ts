export const DCR_CAPABILTY_DISCOVERY_TIMEOUT = 20000;

/**
 * The clientInfo sent to a server when the caller sets none. clientInfo is required by the protocol and every 2.x caller already sends this value, so it stays until the next major removes it.
 */
export const LEGACY_CLIENT_INFO = { name: 'mcp-cli-client', version: '1.0.0' } as const;

export const SHARED_FILE_PROTOCOL = 'file+shared:';
export const DEFAULT_STORE_DIR = '.mcp-z';
export const DEFAULT_STORE_FILE = 'tokens.json';

/** The redirect URI of a pass that binds no listener (a token refresh): a refresh request never carries it, so it is never sent anywhere. */
export const UNBOUND_CALLBACK_URL = 'http://127.0.0.1/callback';
