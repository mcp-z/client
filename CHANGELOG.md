# Changelog

## [2.2.1] - 2026-09-08

### Fixed

- **Discovery fetches can no longer be redirected to an internal address by a hostname that changes its answer between validation and request.** A remote server can point OAuth discovery (protected-resource and authorization-server metadata, the token and registration endpoints) at a hostname it controls. That hostname could answer with a public address when the client checked it and an internal one (loopback, link-local, or a private network address) when the client actually connected, so the request landed somewhere the check never saw. The address the client validates is now the address it connects to: a DNS answer that changes after validation can no longer steer the request. No API change; behaviour for well-behaved servers is unchanged.

## [2.2.0] - 2026-09-07

### Added

- **Protocol version negotiation is now available on connect.** `registry.connect(name, { versionNegotiation })` (and `connectMcpClient`) accepts the SDK's `VersionNegotiationOptions` and passes it through to the MCP client for every transport. The option is omitted by default, so existing callers keep the plain 2025 connect sequence unchanged.
  - `{ mode: 'auto' }` probes the server with a `server/discover` request first and connects at the newest revision the server offers, falling back to the 2025 sequence when the server cannot serve the modern era.
  - `{ mode: { pin: '2026-07-28' } }` requires that revision; a server that does not offer it fails the connect with the SDK's typed era-negotiation error instead of silently downgrading.
  - A connected client reports what it settled on via `getProtocolEra()` (`'modern' | 'legacy'`) and `getNegotiatedProtocolVersion()`.
- Re-exports of the SDK's negotiation surface so callers can handle an era mismatch without depending on `@modelcontextprotocol/client` directly: `SdkError`, `SdkErrorCode` (use `SdkError.isInstance(error)` and `error.code === SdkErrorCode.EraNegotiationFailed`), and the `VersionNegotiationOptions` type.

## [2.1.0] - 2026-09-07

### Fixed

- **The RFC 8707 `resource` indicator named the wrong resource on every OAuth request.** A server configured as `https://example.com/mcp` asked its authorization server for a token audience-bound to `https://example.com` — the deployment root, which is not a protected resource. An authorization server that validates the indicator rejects that with `invalid_target` before the consent screen, so DCR authentication against such a server could never complete. Reproduced against Todoist, whose metadata advertises `resource_parameter_supported: true`; the value is now accepted and the flow reaches consent. Every server whose URL ends in `/mcp` was affected. Servers that ignore the parameter — which is what our own `oauth-google` and `oauth-microsoft` do — were unaffected, which is why this went unseen.
- Authorization, token exchange and refresh all carried the wrong value, so a server could accept the authorization request and still reject the token request.

### Added

- `AuthCapabilities.resource` — the protected resource's canonical identifier, taken from the RFC 9728 metadata document that discovery already fetches. Previously that field was read for its `authorization_servers` and the rest discarded. The resource server's own statement of its identity is what the `resource` indicator now carries; the configured URL stands in only when no such document is published.

### Changed

- Discovery is now given the MCP server's canonical URL with its path intact, rather than the `/mcp`-stripped deployment root. This re-enables the resource-specific (sub-path) branch of RFC 9728 discovery, which could not be reached before: with no path to work from, discovery returned the root document and never looked for the more specific one.
- **Stored credentials are re-keyed, so every server re-authorizes once on upgrade.** Keys include the server URL, and that URL now keeps its path. Cached tokens were audience-bound to an identifier the server does not recognise, so re-authorizing is the correct outcome rather than something to migrate. `deleteTokens()` takes the same URL as `ensureAuthenticated()` and needs no change at a call site that already passed the configured URL.

## [2.0.1] - 2026-09-06

### Changed

- Internal MCP SDK swapped from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/client` 2.x. This is an implementation detail: the SDK is not re-exported and is not named anywhere in this package's documented surface, so connecting, calling tools, reading resources and getting prompts behave exactly as before.
- `ManagedClient.callTool` / `callToolRaw`: the **native passthrough** overload is now `(invocation, requestOptions?)` instead of `(invocation, sessionId?, requestOptions?)`. SDK 2.x dropped `callTool`'s `resultSchema` parameter, making it consistent with `getPrompt` and `readResource`, which already had this shape. The string form — `callTool(name, args?, requestOptions?)` — is unchanged, and it is the form the documented API uses.

### Removed

- The `Protocol.close()` monkey patch. SDK 1.x leaked pending request timeouts on close, hanging Node for ~60s after a suite finished; 2.x aborts an `AbortController` instead and has no such leak. Verified by the check the patch itself documented: the suite now exits in 15.5s against 15s of test time.

## [2.0.0] - 2026-09-06

### Changed

- OAuth client hardened for the `2026-07-28` authorization spec: RFC 9207 `iss` validation, RFC 8707 `resource`, and SEP-2352 issuer-keyed credentials. Stored credentials are now keyed by issuer rather than by resource URL, so existing DCR registrations re-register on first use.
- `AuthCapabilities` gained `issuer`. A DCR fixture or caller that omits it now fails at `requireIssuer` before any request is made.

### Added

- `support/1.x` maintenance line, published under the `support-1` dist-tag, with a publish guard that refuses a bare `npm publish` from that branch.

## [1.2.0] - 2026-09-05

### Fixed

- OAuth discovery no longer follows `resource_metadata` and `authorization_servers` URLs to arbitrary addresses. Discovery fetches now validate the resolved address range and reject non-unicast destinations, with loopback allowed only where a caller explicitly grants it (SSRF hardening).

### Changed

- Transport close behavior tightened so a closed client no longer leaves the process waiting on a live child.

## [1.1.0] - 2026-08-29

### Changed

- `engines.node` raised to `>=20`.

## [1.0.0] - 2025-12-28

Initial release.
