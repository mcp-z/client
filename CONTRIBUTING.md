# Contributing to @mcp-z/client

Programmatic MCP client library for Node.js - connect, discover, and call tools on Model Context Protocol servers.

## Before Starting

A few conventions here differ from what you might expect:

- **Breaking changes over compatibility.** This project has no compatibility burden yet. Do not add back-compat layers, migration utilities, or wrappers for deprecated APIs - change the API cleanly and bump the major.
- **Keep it approachable.** This is a small community project, not an enterprise codebase. Prefer the simplest solution that fits in the existing files over new abstractions, frameworks, or shared infrastructure.
- **Tests use real components, not mocks.** Prefer exercising the real thing over standing up a fake.
- **Test scratch goes in the package's gitignored `.tmp/`**, never `os.tmpdir()`.

## Branches

`master` is the only maintained release line. The 1.x line is retired and receives no fixes. All changes target `master`.

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

`registry.connect()` returns a managed view of the MCP SDK `Client` with helper overloads (see `src/client-helpers.ts`). `nativeClient` is the original SDK instance; the managed view has a separate identity and shares its connection and state. SDK methods and getters use that actual instance as receiver, and close is resolved dynamically. Stdio adds a registry lease that binds function reads, so callback and method references need not retain identity through that lease. Add ergonomics through the managed view without subclassing, copying SDK state or modifying the upstream class.

## GitHub Actions

CI follows the Linux/Windows template used by each-package: Node 26, `npm ci`, `prepublishOnly`, a current-runtime test run, and the supported-engine sweep. macOS coverage runs locally. Pull requests receive no provider credentials.

`npm test`, `npm run test:ci`, `npm run test:engines` and `npm run test:ci:engines` discover all tests. The six automated Todoist metadata discovery cases need network access to the public service and no provider credentials.

CI sets `TEST_INCLUDE_MANUAL=false`. The manual Todoist consent case requires a person and is separately opted in with `TEST_INCLUDE_MANUAL=true`. Automated discovery coverage does not validate the manual OAuth flow.

The `Todoist Discovery` workflow runs the six public metadata discovery tests on Ubuntu and Windows with Node 26 every Tuesday at 06:17 UTC, and can be dispatched on `master`. It needs no provider credentials and keeps the browser consent tests disabled.
