/**
 * Authentication Module
 * Exports public API for OAuth authentication only (DCR moved to ../dcr/)
 */

export { probeAuthCapabilities } from './capability-discovery.ts';
export { InteractiveOAuthFlow } from './interactive-oauth-flow.ts';
export type { OAuthCallbackListenerOptions } from './oauth-callback-listener.ts';
export { OAuthCallbackListener } from './oauth-callback-listener.ts';
export type { AuthCapabilities, CallbackResult, OAuthFlowOptions, TokenSet } from './types.ts';
