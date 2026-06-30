# Contributing to agent-smith

Thanks for taking the time to contribute. This project is early, so the design is still
moving. If you want to land something non-trivial, open an issue first so we can agree on
the approach before you write code.

## Getting started

This is a [Bun](https://bun.com) workspace. You need Bun installed; you do not need Node.

```sh
bun install      # install + set up git hooks (lefthook)
bun run dev      # start the server on :3000
bun test         # run all tests
bun run check    # format + lint with biome (auto-fixes)
```

Read [`docs/SPEC.md`](./docs/SPEC.md) first. It is the source of truth for the
architecture, the package boundaries, and the contracts everything builds on.

## Project layout

| Path | Package |
| --- | --- |
| `packages/mcp-gateway` | core: contracts, registry, host |
| `packages/mcp-gateway-middleware-logging` | example middleware |
| `packages/mcp-gateway-backend-child-process` | example connector |
| `apps/server` | the Hono server |

New isolation models (docker, microvm) go in their own `packages/mcp-gateway-backend-*`
package behind the `BackendConnector` contract. New middleware goes in
`packages/mcp-gateway-middleware-*` behind the `Middleware` contract.

## Pull requests

- Branch off `main`. Keep PRs focused; one logical change per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages and
  the PR title (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- `bun run check` and `bun test` must pass. CI runs biome and the test suite on every push
  and PR.
- Add or update tests for behavior changes. Update `docs/SPEC.md` if you change a contract.
- Describe what changed and why. Link the issue it closes.

## Reporting bugs and proposing features

Use the issue templates. For anything security-related, do not open a public issue; see
[`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
