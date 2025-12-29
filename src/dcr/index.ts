/**
 * DCR (Dynamic Client Registration) Module
 * Exports public API for DCR authentication
 */

export type { ClientCredentials, DcrRegistrationOptions } from '../auth/types.ts';
export type { DcrAuthenticatorOptions } from './dcr-authenticator.ts';
export { DcrAuthenticator } from './dcr-authenticator.ts';
export { DynamicClientRegistrar } from './dynamic-client-registrar.ts';
