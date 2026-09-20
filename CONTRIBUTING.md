# Contributing to @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Before Starting

A few conventions here differ from what you might expect:

- **Breaking changes over compatibility.** This project has no compatibility burden yet. Do not add back-compat layers, migration utilities, or wrappers for deprecated APIs - change the API cleanly and bump the major.
- **Keep it approachable.** This is a small community project, not an enterprise codebase. Prefer the simplest solution that fits in the existing files over new abstractions, frameworks, or shared infrastructure.
- **Tests use real components, not mocks.** Prefer exercising the real thing over standing up a fake.
- **Test scratch goes in the package's gitignored `.tmp/`**, never `os.tmpdir()`.

## Branches

Two lines. `master` is the current major and where all new work goes; `support/1.x` maintains the 1.x line for consumers who have not migrated.

    master          2.x    current    the v2 MCP SDK, both protocol eras
    support/1.x     1.x    security fixes only, cut at v1.2.0

Check which one you are on before editing:

```bash
git rev-parse --abbrev-ref HEAD
```

Features, dependency migrations and API changes go to `master` only. A security fix that also affects 1.x is **cherry-picked** to `support/1.x` — never merge the branches into each other, in either direction.

This file is the 1.x line's guide too. It lives only on `master` so it cannot drift between the lines; from `support/1.x`, read it with `git show master:CONTRIBUTING.md`.

Releasing `support/1.x` carries one trap. `npm publish` moves `latest` to the highest version published, so a 1.x release made after 2.0.0 exists must name its dist-tag or every bare `npm install @mcp-z/client` serves the old line:

```bash
npm publish --tag support-1
```

`prepublishOnly` refuses a bare publish from `support/1.x`, so forgetting the flag fails the publish rather than moving `latest`. `npm dist-tag add @mcp-z/client@<version> latest` reverses a mistake at any time.

## Pre-Commit Commands

Install ts-dev-stack globally if not already installed:

```bash
npm install -g ts-dev-stack
```

Run before committing - this builds, type-checks, lints, and tests:

```bash
tsds validate
```

`tsds validate` also runs automatically on `npm publish` via the `prepublishOnly` hook; a failure blocks the publish.

## Testing

```bash
npm test              # Run the test suite
npm run test:engines  # Run the suite across every supported Node version
```

Specs live in `test/unit/`, mirroring `src/`. Cross-service specs live in `test/integration/`. Both run under `npm test`.

## Package Development

See `README.md` for package overview and usage.

### Key design note: client helpers via decoration

`registry.connect()` returns the MCP SDK `Client` decorated with helper overloads (see `src/client-helpers.ts`). We intentionally avoid subclassing or patching the upstream class so we can adopt SDK updates without tracking its constructor/private internals. Always add new ergonomics through the decorator instead of modifying the SDK class directly.

## GitHub Actions

CI follows the Linux/Windows template used by each-package: Node 26, `npm ci`, `prepublishOnly`, a current-runtime test run, and the supported-engine sweep. macOS coverage runs locally. Pull requests receive no provider credentials.

`npm run test:ci` and `npm run test:ci:engines` run the credential-free selection. They exclude `test/integration/auth/todoist-oauth.test.ts`. These files require provider configuration, live services, or interactive consent; some also contain local checks. Their exclusion is a coverage gap until the separate live-service automation is provisioned.

`npm test` and `npm run test:engines` retain full discovery. CI sets `TEST_INCLUDE_MANUAL=false`; consent tests require a person and run locally with `TEST_INCLUDE_MANUAL=true`. A green credential-free check does not certify live-provider behavior. Release evidence must include the configured live suites and relevant manual OAuth flows.

The `Todoist Discovery` workflow runs the six public metadata discovery tests on Ubuntu and Windows with Node 26 every Tuesday at 06:17 UTC, and can be dispatched on `master`. It needs no provider credentials and keeps the browser consent tests disabled.
