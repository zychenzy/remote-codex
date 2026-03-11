# Contributing

## Local setup

1. Use Node.js 20+.
2. Run `npm test` before opening a PR.
3. Use `npm run tool -- setup` for local daemon configuration.

## Development expectations

- Keep runtime integration centered on `codex app-server`.
- Keep Telegram/Discord adapters aligned with the `ChannelAdapter` interface.
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
