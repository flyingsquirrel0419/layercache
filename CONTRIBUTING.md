# Contributing to layercache

Thanks for your interest in contributing to `layercache`.

## Workflow

1. Fork the repository.
2. Create a topic branch for your change.
3. Implement the change with tests and documentation updates where needed.
4. Run the local checks before opening a pull request.
5. Submit a PR with a clear summary of the problem and the fix.

## Local checks

```bash
npm install
npm run lint
npm test
npm run build:all
```

## Standards

- Use [Biome](https://biomejs.dev/) formatting and lint rules.
- Keep changes focused and avoid mixing unrelated work in one PR.
- Add or update tests whenever behavior changes.
- Keep `README.md` and `CHANGELOG.md` in sync with user-facing changes.

## Issues and feature requests

If you find a bug or want to propose an improvement, open a GitHub issue with:

- a clear description of the behavior
- reproduction steps or a minimal example
- expected versus actual results
- runtime details when relevant

## Community

Participation in this project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
