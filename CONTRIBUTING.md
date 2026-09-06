# Contributing to @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Branches

Two lines. `master` is the current major and where all new work goes; `support/1.x` maintains the 1.x line for consumers who have not migrated.

    master          2.x    current    the v2 MCP SDK, both protocol eras
    support/1.x     1.x    security fixes and bugs only, cut at v1.2.0

Check which one you are on before editing:

```bash
git rev-parse --abbrev-ref HEAD
```

Features, migrations and new APIs go to `master` only. A fix that also affects the 1.x line is cherry-picked to `support/1.x`, never merged across. Releases from `support/1.x` publish under the `support-1` dist-tag, never `latest`; `prepublishOnly` refuses a bare publish from this branch.

## Before Starting

A few conventions here differ from what you might expect:

- **Breaking changes over compatibility.** This project has no compatibility burden yet. Do not add back-compat layers, migration utilities, or wrappers for deprecated APIs - change the API cleanly and bump the major.
- **Keep it approachable.** This is a small community project, not an enterprise codebase. Prefer the simplest solution that fits in the existing files over new abstractions, frameworks, or shared infrastructure.
- **Tests use real components, not mocks.** Prefer exercising the real thing over standing up a fake.
- **Test scratch goes in the package's gitignored `.tmp/`**, never `os.tmpdir()`.

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
