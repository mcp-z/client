# Changelog

## [1.2.1] - 2026-09-06

### Fixed

- `deleteTokens` now removes self-hosted DCR credentials as well as external OAuth ones. It deleted only the `tokens:` family, so revoking credentials for a self-hosted DCR server reported success while leaving a valid access and refresh token on disk.

## [1.2.0] - 2026-09-05

### Fixed

- OAuth discovery no longer follows `resource_metadata` and `authorization_servers` URLs to arbitrary addresses. Discovery fetches validate the resolved address range and reject non-unicast destinations, with loopback allowed only where a caller explicitly grants it (SSRF hardening).
- Transport close no longer leaves the process waiting on a live child.

### Added

- `isLoopbackUrl`, and an `allowLoopback` option on DCR registration, for callers that legitimately talk to a loopback server.

## [1.1.0] - 2026-08-29

### Changed

- `engines.node` raised to `>=20`.

## [1.0.0] - 2025-12-28

Initial release.
