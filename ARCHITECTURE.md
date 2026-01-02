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

## DCR and OAuth Flow
When a server requires OAuth:
1) **DCR (RFC 7591)** registers a client using the `registration_endpoint`.
2) **Authorization Code + PKCE (RFC 6749 + RFC 7636)** is used to obtain tokens.
3) **Token exchange** uses the `token_endpoint` defined in RFC 8414 metadata.

These flows are implemented in:
- `src/auth/*`
- `src/connection/connect-client.ts`

## Design Principles
- Standards first: prefer RFC-defined discovery signals over provider-specific behavior.
- Fast start: process spawning does not block on readiness; connections are lazy.
- Explicit failure: discovery returns `supportsDcr: false` when standards-based endpoints are unavailable.
