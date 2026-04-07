# Contributing to layercache

First off, thanks for considering contributing to layercache! Every contribution matters - whether it's a bug fix, documentation improvement, performance optimization, new adapter, or a well-written issue report.

## Getting Started

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
```

## Development Workflow

1. **Fork** the repository and create a topic branch from `main`.
2. **Implement** your change with tests and documentation updates where needed.
3. **Run local checks** to make sure everything passes.
4. **Submit** a PR with a clear summary of what changed and why.

## Local Checks

Run all checks before opening a PR:

```bash
npm run lint        # Biome linting & formatting
npm test            # Vitest test suite
npm run build:all   # ESM + CJS + NestJS package
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

## Code Standards

- **Formatting** - Use [Biome](https://biomejs.dev/) formatting and lint rules. Run `npm run lint:fix` to auto-fix.
- **Testing** - Add or update tests whenever behavior changes. We use [Vitest](https://vitest.dev/).
- **Focus** - Keep changes focused. Avoid mixing unrelated work in one PR.
- **Documentation** - Keep `README.md`, `docs/`, and `CHANGELOG.md` in sync with user-facing changes.
- **Types** - This is a TypeScript-first project. Maintain strong typing.

## Project Structure

```
src/
  index.ts              # Public API exports
  CacheStack.ts         # Core orchestrator
  CacheNamespace.ts     # Scoped cache views
  types.ts              # TypeScript interfaces
  layers/               # Cache backend implementations
  invalidation/         # Tag/pattern invalidation
  stampede/             # In-process stampede prevention
  singleflight/         # Distributed single-flight
  internal/             # Internal utilities
  serialization/        # JSON, MessagePack serializers
  integrations/         # Express, Fastify, Hono, etc.
  metrics/              # Prometheus exporter
  http/                 # Stats HTTP handler
tests/                  # Mirror of src/ structure
packages/nestjs/        # NestJS module workspace
examples/               # Ready-to-run example projects
benchmarks/             # Performance benchmarks
docs/                   # Documentation
```

## What to Contribute

Here are some areas where contributions are especially welcome:

- **Bug fixes** - Found a bug? A fix with a regression test is the best kind of contribution.
- **Documentation** - Typos, unclear explanations, missing examples - all improvements welcome.
- **Performance** - Profiled something slow? Benchmarks and optimizations are great.
- **New cache layers** - Adapters for other backends (e.g., SQLite, DynamoDB, Cloudflare KV).
- **Framework integrations** - Middleware for frameworks not yet supported.
- **Test coverage** - More edge cases, more scenarios, more confidence.

## Reporting Issues

When filing a bug report, please include:

- A clear description of the problem
- Reproduction steps or a minimal example
- Expected vs. actual results
- Node.js version, layercache version, and relevant runtime details
- If applicable, the cache layer configuration you're using

## Suggesting Features

Feature requests are welcome! Please include:

- The use case / problem you're trying to solve
- A proposed API or behavior (even rough ideas help)
- Any alternatives you've considered

## Community

Participation in this project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). Please be respectful and constructive.

---

Thank you for helping make layercache better!
