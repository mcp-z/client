# Changelog

## [2.6.0] - 2026-11-20

### Security

- An authorization server whose metadata names a different issuer than the one it was fetched for (RFC 8414 section 3.3) is now refused in discovery, before any token, code or client secret is sent to it. Before, a resource server could name an authorization server whose metadata claimed another issuer and point its token endpoint at itself.
- A token or registration endpoint that answers with a redirect is now refused instead of followed. Before, the request, including the authorization code, refresh token and client secret, was sent again to the redirect target.

### Added

- `dcrAuthenticator.clientMetadataUrl`: the https URL of a client metadata document your application hosts. When you pass it, the client sends it as its `client_id` to servers that accept client metadata documents (CIMD), so nothing is registered at the server and no client secret is stored; on a server that offers only dynamic registration (DCR) it registers as before. There is no default: without the option the client never offers a document and registers, so a server that offers only CIMD fails with "Incompatible auth server: does not support dynamic client registration". The server must be able to fetch your document. Servers built on oauth-google or oauth-microsoft before 2.4.3 advertise CIMD but refuse a loopback redirect on a port the document does not list, so leave the option out for them.
- `dcrAuthenticator.clientName`: the name the client registers under (DCR).
- `probeAuthCapabilities` reports `supportsCimd` and the authorization server metadata as it was received (`authorizationServerMetadata`); `connect` signs in whenever a server offers CIMD or DCR.

### Changed

- Sign-in runs on the MCP SDK's `auth()`. A client the server no longer knows (`invalid_client`) is registered again.
- The registration no longer carries `client_name` unless you set `clientName`: a server now sees no client name from this client by default (`DynamicClientRegistrar` too).
- A server that does not return `state` in the authorization response now fails the sign-in, and so does a response with the wrong `state`; before, `state` was not checked.
- The sign-in callback is on `127.0.0.1` (`http://127.0.0.1:<port>/callback`), not `localhost`. You could notice this if you pass your own `redirectUri` to `dcrAuthenticator` (it is used as given, and a `localhost` one is refused by a CIMD server whose document lists only `127.0.0.1`), if a firewall or proxy rule names `localhost`, or if an authorization server's allow-list holds a redirect URI registered for `localhost`.
- A server whose protected-resource metadata names a resource that does not contain the server's URL (for example one that publishes `https://other.example/mcp` for `https://host.example/mcp`) is now refused, as RFC 9728 requires, and the connect fails with the SDK's error. Before, the named resource was used as it was, so a misconfigured third-party server that worked will stop working until its metadata is fixed.
- Servers on `localhost` or `127.0.0.1` are treated like any other server: the client no longer asks them to verify a stored token at `/oauth/verify`. Instead the transports (Streamable HTTP and SSE) refresh the token when the server answers 401, and while connecting they sign in again, opening the browser, when the refresh is refused. A 401 after the client has connected refreshes the token but never opens a browser: a request that needs a new sign-in fails with `UnauthorizedError`, and connecting again signs in. A sign-in that fails while connecting no longer falls back to SSE and opens a second one.
- A stored sign-in is no longer deleted because the authorization server could not be reached, answered with a server error (5xx), or the request was cancelled; none of these starts a new sign-in either. Only an answer that rejects the credentials (`invalid_grant`, `invalid_client`) does.
- A token response without `expires_in` is stored with an unknown expiry: the token is used, with no refresh before it, until the server answers 401, and then refreshed. A sign-in saved by an earlier release with no expiry is read the same way instead of being refreshed at every connect.
- A refresh the server refuses (`invalid_grant`) after the client has connected no longer registers a new client at the server before the request fails with `UnauthorizedError`.
- A sign-in stored by an earlier release is refreshed with the client authentication method the server advertises, as the server's metadata says.
- `DcrAuthenticator`, `DynamicClientRegistrar`, `InteractiveOAuthFlow` and `probeAuthCapabilities` stay exported. `OAuthCallbackListener` takes an optional `host`, which defaults to `localhost` as before.

### Fixed

- Existing sign-ins keep working after upgrading: a stored token is used and refreshed with the registration it was made with, tokens in the `dcr-tokens` entries of localhost servers are read, and an expired token that cannot be refreshed is replaced by a new sign-in. New sign-ins are saved in the same `tokens:` entries and shape as before, plus a `client:` entry for the registration; `deleteTokens()` removes all of them. A client older than this release signs in again when a sign-in made through CIMD has expired, because there is no client secret for it to refresh with.

## [2.5.3] - 2026-11-20

### Security

- On Windows, sign-in opened the browser through `cmd`, so every authorization URL was cut at its first `&` (sign-in could not complete), and an authorization server could make the URL run another command or send it your environment variable values. The URL is now handed to the browser unchanged on every system, and only `http` and `https` URLs are opened.

### Fixed

- When the browser cannot be opened (no `xdg-open`, a refused URL), sign-in prints the URL to open by hand instead of the process exiting with an unhandled `spawn ENOENT` error.

## [2.5.2] - 2026-11-19

### Fixed

- Saved sign-ins in the default store (`.mcp-z/tokens.json`) no longer overwrite, or get overwritten by, the servers or other processes using the same file. Each change is saved under a lock and every read sees the current file. The file is now written with mode 0600 on macOS and Linux. An older client or mcp-z server running beside this one still rewrites the file, so upgrade the cli and servers together.
- A damaged `.mcp-z/tokens.json` is reported with its path and left unchanged. Before, it was read as having no sign-ins and then overwritten. Move the file aside or repair it to continue.
- `keyv-registry` `^3.1.0`, which the shared store requires, is now the minimum; `proper-lockfile`, `@keyv/serialize` and `temp-suffix` are installed with the package, and `keyv-file` no longer is.

## [2.5.1]

### Fixed

- On Windows, closing a server that was started through `cmd.exe` (a `.cmd` file, `npm`) now also stops the processes it started. Before, the real server could keep running and `close()` reported a cleanup failure.

## [2.5.0]

### Changed

- Sign-ins saved by an earlier version in the default store (`.mcp-z/tokens.json`) are moved to the new storage format once, on first use, so users stay signed in. A store you pass in is left alone.
- A custom `tokenStore` passed to `DcrAuthenticator` is a keyv 6 `Keyv`. `deleteTokens()` lists the store's keys to find a server's tokens; for a store that cannot list its keys it deletes nothing instead of throwing.

## [2.4.2] - 2026-11-16

### Fixed

- A self-hosted DCR sign-in is no longer deleted when the token verification request fails (network error, abort). The call now rejects and keeps the stored token; the token is deleted only when the server answers that it is invalid.
- `probeAuthCapabilities()` no longer reports "no DCR" (so the client connects without authentication) when a location the server itself advertised cannot be used: a `resource_metadata` URL from `WWW-Authenticate`, an authorization server named by the resource metadata, or an issuer from the header. A `resource_metadata` URL answering a non-OK status (404, 500) now rejects as well. A network failure, a refusal by the SSRF guard, invalid JSON or an oversize response there now rejects. Guessed well-known locations (and the unprompted request to the server URL) that fail, return HTML, redirect or are refused still mean "not offered", so servers without authentication keep connecting.
- Building the capability index for search (`buildCapabilityIndex()`, `search()`, and spawned-server capability search) now rejects when a server's `listTools`, `listPrompts` or `listResources` fails. Only a JSON-RPC `MethodNotFound` answer is treated as "the server has none".

## [2.4.1] - 2026-10-12

### Fixed

- `registry.close()` no longer reports a shutdown failure when a POSIX server has already closed and its process group is empty, but sending the shutdown signal returns `EPERM`. The signal error remains logged; other shutdown failures still reject.

## [2.4.0] - 2026-10-10

### Changed

- Remove `callToolRaw()`, `getPromptRaw()`, `readResourceRaw()` and response `raw()`. Use the corresponding managed call and its standard response fields, or `JSON.stringify(response)` for the complete MCP result including server extensions. Tool content/structuredContent, prompt description/messages, resource contents and metadata retain their data. Existing `json()` and `text()` conversions remain unchanged.
- Awaited managed tool calls now reject MCP `isError` results with `ToolResponseError`; inspect `error.response` for the complete error result. Protocol/transport failures continue to reject, and representation failures occur during conversion.
- The managed client is a separate view of the original SDK instance returned by `nativeClient`. Native methods retain SDK behavior and share the actual connection/state. Stdio lease close releases its reference; native close closes the connection directly. Callback and method references through the stdio lease need not retain identity.

### Fixed

- OAuth callback port selection checks availability on localhost, matching the callback listener's address and reducing startup failures caused by probing a different interface.

## [2.3.0] - 2026-09-20

### Added

- `start.stop` lets an owned HTTP server declare a structured, shell-free command for its application-specific shutdown mechanism. The registry runs it once during `registry.close()` and then waits for the server to exit. MCP HTTP does not define a shutdown request, so the server must implement the mechanism. The stop command does not run for external servers or when a client releases a shared-server lease.

### Changed

- `registry.close()` sends stdin EOF before escalating stdio shutdown, waits for actual child closure, shares concurrent close completion, attempts cleanup of every owned resource, and reports teardown errors. Cooperative shutdown returns `timedOut: false` and `killedCount: 0`. On Windows, emergency termination can target only the direct child; a descendant left running after a wrapper exits is outside the ownership guarantee. POSIX shutdown continues to track the detached process group.

### Fixed

- OAuth discovery and transport connection deadlines now abort active HTTP requests and wait for bounded cleanup. Cleanup failures remain visible to callers.

## [2.2.4] - 2026-09-20

### Fixed

- **Windows server shutdown now stops the complete process tree.** Shell-launched servers could leave their Node process running after the shell exited, keeping inherited stdio open and causing test runners to hang.

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
