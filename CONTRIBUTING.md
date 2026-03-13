# Contributing

## Local setup

1. Use Node.js 24 LTS+.
2. Run `npm test` before opening a PR.
3. Use `npm run tool -- setup` for local daemon configuration.

## Development expectations

- Keep runtime integration centered on `codex app-server`.
- Keep the Discord adapter aligned with the `ChannelAdapter` interface.
- Preserve secure defaults:
  - allowlists for command execution
  - approval prompts for command/file-change operations
  - redacted logs and local secret storage

## Commit style

Use small, atomic commits.

- One focused change per commit.
- Keep commit message concise and specific.
- Use conventional prefixes:
  - `feat: ...`
  - `fix: ...`
  - `chore: ...`
  - `test: ...`
  - `docs: ...`

Good examples:

- `feat: add thread resume command in CLI`
- `fix: recover from stale daemon pid state`
- `test: add command approval timeout case`

## CI alignment

- Keep CI green across Node 24/25.
- For behavior changes, include or update tests in the same PR.
- Prefer small, focused PRs that align with the commit rules above.
