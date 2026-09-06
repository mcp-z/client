# Changelog

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
