# Contributing to @mcp-z/cli

## Before Starting

**MUST READ**:
- [QUALITY.MD](QUALITY.md) - Quality principles (summarize before starting work)

## Pre-Commit Commands

Install ts-dev-stack globally if not already installed:
```bash
npm install -g ts-dev-stack
```

Run before committing:
```bash
tsds validate
```

## Package Development

See package documentation:
- `README.md` - Package overview and usage
- `QUALITY.md` - Quality principles and standards
- `CLAUDE.md` - Development patterns and architecture guidance

### Key design note: client helpers via decoration

`registry.connect()` returns the MCP SDK `Client` decorated with helper overloads (see `src/client-helpers.ts`). We intentionally avoid subclassing or patching the upstream class so we can adopt SDK updates without tracking its constructor/private internals. Always add new ergonomics through the decorator instead of modifying the SDK class directly.
