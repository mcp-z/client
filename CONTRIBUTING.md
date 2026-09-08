# Contributing to @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Before Starting

A few conventions here differ from what you might expect:

- **Breaking changes over compatibility.** This project has no compatibility burden yet. Do not add back-compat layers, migration utilities, or wrappers for deprecated APIs - change the API cleanly and bump the major.
- **Keep it approachable.** This is a small community project, not an enterprise codebase. Prefer the simplest solution that fits in the existing files over new abstractions, frameworks, or shared infrastructure.
- **Tests use real components, not mocks.** Prefer exercising the real thing over standing up a fake.
- **Test scratch goes in the package's gitignored `.tmp/`**, never `os.tmpdir()`.

## Branches

One line. `master` is the only maintained branch.

**The 1.x line ended at `v1.3.0` (2026-09-08).** That release carries the 2.x tree, so 1.x
consumers could take every fix by upgrading in place rather than waiting on backports. There will be
no further 1.x releases, including for security.

`support/1.x` was retired with it. Nothing is lost — the tags hold the whole history, and the branch
can be recreated from the final tag if it is ever needed.

```bash
git checkout -b support/1.x v1.3.0
```

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
