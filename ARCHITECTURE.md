# MCP-Z Client Architecture

## Overview
The client package provides two primary capabilities:
- MCP server connectivity (stdio and HTTP transports) with lifecycle management.
- OAuth 2.0 discovery and Dynamic Client Registration (DCR) for MCP servers that require authentication.

This document summarizes standards compliance and the discovery/authorization flows implemented by the client.

## Standards Compliance
The client implements the following standards:
- MCP transports and server metadata: https://modelcontextprotocol.io/specification
- OAuth 2.0 Authorization Server Metadata (RFC 8414): https://www.rfc-editor.org/rfc/rfc8414
- OAuth 2.0 Protected Resource Metadata (RFC 9728): https://www.rfc-editor.org/rfc/rfc9728
- OAuth 2.0 Authorization Server Issuer Identification (RFC 9207): https://www.rfc-editor.org/rfc/rfc9207
- Dynamic Client Registration (RFC 7591): https://www.rfc-editor.org/rfc/rfc7591
- OAuth 2.0 Authorization Framework (RFC 6749): https://www.rfc-editor.org/rfc/rfc6749
- Proof Key for Code Exchange (RFC 7636): https://www.rfc-editor.org/rfc/rfc7636

## MCP Server Support
Supported MCP server connectivity features:
- Stdio transport: spawns local servers and connects over stdin/stdout.
- HTTP transport: connects to remote servers and supports "start" blocks for local HTTP server spawning.
- Server registry: tracks spawned processes and connected clients for coordinated shutdown.

Primary entry points:
- `createServerRegistry` (lifecycle + connection management)
- `connectMcpClient` (connects and negotiates with a named server)

## OAuth Discovery Flow (RFC 9728 → RFC 8414)
The client discovers OAuth server capabilities using standards-aligned steps:
1) **RFC 9728 protected resource metadata**
   - Probes `/.well-known/oauth-protected-resource` at the resource origin.
   - If the resource URL includes a path, also probes `/.well-known/oauth-protected-resource{path}`.
   - If a response includes `WWW-Authenticate: Bearer resource_metadata="..."`, the client fetches that document directly.
2) **RFC 8414 authorization server metadata**
   - Uses the `authorization_servers` list from RFC 9728 to fetch
     `/.well-known/oauth-authorization-server` for the selected issuer.
3) **RFC 9207 issuer hint (fallback)**
   - If the authorization server metadata is unavailable, the client attempts
     to read `authorization_server` or `issuer` from `WWW-Authenticate` to find
     the correct issuer and retry RFC 8414 discovery.

These steps are implemented in:
- `src/auth/rfc9728-discovery.ts`
- `src/auth/capability-discovery.ts`

### SSRF mitigation (MCP `2026-07-28` security best practices, RFC 9728 §7.7)

Every URL in this flow after the initial connection - the `resource_metadata`
document, the `authorization_servers` entries, and the endpoints in the RFC
8414 metadata they point at - is supplied by the remote MCP server, not the
caller. A malicious or compromised server can point any of them at cloud
instance metadata (`169.254.169.254`), a loopback service such as a local
Redis or admin panel, or another host on the operator's private network. All
such fetches (including the `token_endpoint` and `registration_endpoint`
fetches in the DCR/OAuth flow below) go through `src/auth/discovery-fetch.ts`,
which enforces:
- `https://` required, and private/link-local/reserved IPv4 and IPv6 ranges
  blocked, using `ipaddr.js` rather than hand-rolled parsing. The MCP spec
  calls this out explicitly: "Avoid implementing IP validation manually.
  Attackers exploit encoding tricks (octal, hex, IPv4-mapped IPv6) that custom
  parsers often miss." `ipaddr.js` normalizes IPv4-mapped IPv6
  (`::ffff:169.254.169.254`) to IPv4 before classifying, and the WHATWG `URL`
  parser used to read the host already canonicalizes octal/hex/decimal IPv4
  literals (`0x7f000001`, `017700000001`, `2130706433` all become
  `127.0.0.1`), so none of those encodings can sneak a private address past
  the check as an opaque hostname string.
- Loopback (`127.0.0.0/8`, `::1`, `localhost`) is the one carve-out, and it is
  granted **per call**, not globally: every caller passes `allowLoopback`
  computed from the MCP server it is actually talking to (the user-configured
  base URL) - never from the URL being fetched. A public, untrusted server
  returning `authorization_servers: ["http://127.0.0.1:6379/"]` is refused
  even though the address is loopback; `http://localhost:3000/oauth/token`
  from a server the caller is already talking to over loopback is allowed.
  This is what keeps the local OAuth callback flow and the test suite working
  without configuration, without also trusting loopback targets a remote
  server merely claims are safe. There is no global opt-out: a call site
  that needs a private address grants it explicitly via `allowLoopback`, or
  it is refused.
- Every redirect hop re-validated with the same grant (redirects are not
  auto-followed).
- For a hostname target (not a literal IP, and not `localhost` under an
  `allowLoopback` grant), DNS is resolved ourselves and every returned
  address is checked before the original URL is handed to `fetch`. This
  blocks the common case (attacker's hostname resolves to an internal
  address) but does not fully close the DNS-rebinding race where the record's
  TTL expires and the answer changes between our lookup and `fetch`'s own
  resolution a moment later; closing that fully requires pinning the resolved
  address at the connection layer (e.g. a custom `undici.Agent` with an
  overridden `connect`/`lookup`), which is not implemented here.
- An aggressive connect/read timeout and a response body size cap enforced
  while reading, not after.
- A single, generic error message on failure so internal network topology is
  never reflected back to whatever triggered the discovery.

## DCR and OAuth Flow
When a server requires OAuth:
1) **DCR (RFC 7591)** registers a client using the `registration_endpoint`, as
   `application_type: "native"` with the OS-assigned loopback redirect URI the
   callback listener has already bound (RFC 8252).
2) **Authorization Code + PKCE (RFC 6749 + RFC 7636)** is used to obtain tokens.
3) **Token exchange** uses the `token_endpoint` defined in RFC 8414 metadata.
4) **`iss` validation (RFC 9207)** compares the authorization response's `iss`
   against the issuer discovered before the flow started. A mismatch, or an
   omitted `iss` from a server advertising
   `authorization_response_iss_parameter_supported`, aborts the flow and the
   authorization code is never redeemed.
5) **`resource` (RFC 8707)** carries the canonical resource server URI on the
   authorization, token, and refresh requests, so issued tokens are
   audience-bound to one resource.
6) **Credentials are keyed by issuer** (`tokens:{issuer}:{resource}`) and carry
   the issuer they were granted by, so a resource whose authorization server
   changes re-authorizes instead of presenting the previous server's tokens.

These flows are implemented in:
- `src/auth/*`
- `src/connection/connect-client.ts`

## Design Principles
- Standards first: prefer RFC-defined discovery signals over provider-specific behavior.
- Fast start: process spawning does not block on readiness; connections are lazy.
- Explicit failure: discovery returns `supportsDcr: false` when standards-based endpoints are unavailable.
