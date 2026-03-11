# AGENTS.md

This repository contains an IM-first Codex remote-control daemon.

## Project intent

- Runtime backend is `codex app-server` only.
- v1 channels are Telegram and Discord.
- Deployment model is local/single-host daemon (no external control plane).
- CLI is the operator surface.

## Repository layout

- `packages/core-runtime`: app-server process lifecycle + JSON-RPC transport.
- `packages/im-gateway`: IM adapters and command parsing.
- `packages/state-store`: local config/state/audit persistence.
- `packages/ops-cli`: daemon orchestration and CLI commands.
- `ref/`: local reference projects (`Claude-to-IM-skill`, `remodex`) for lookup only.

## Development workflow

1. Use Node.js 20+.
2. Run tests with `npm test` after changes.
3. Keep interfaces stable between modules:
- `RuntimeEngine`
- `ApprovalBroker`
- `ChannelAdapter`
- `SessionBinding` / `PolicyProfile`
4. Prefer incremental changes with tests alongside behavior changes.
5. Keep secrets local and redacted in logs.

## Commit rules

- Make atomic, small commits.
- One logical change per commit.
- Commit messages should be short and clear.
- Use conventional prefixes:
  - `feat: ...`
  - `fix: ...`
  - `chore: ...`
  - `test: ...`
  - `docs: ...`

Examples:

- `feat: add app-server runtime reconnect handler`
- `fix: handle stale daemon pid cleanup`
- `test: add approval timeout roundtrip case`

## Guardrails

- Do not add external relay/mobile flows to v1 core.
- Keep desktop sync optional and disabled by default.
- Keep allowlist and approval gating on by default for command/file-change actions.
