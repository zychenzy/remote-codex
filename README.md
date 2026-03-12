# codex-remote

IM-first remote control daemon for Codex, backed by `codex app-server`.

This project lets you run Codex on your host machine and control it from chat apps (Discord/Telegram), while keeping operations local and policy-gated.

## Highlights

- Native `codex app-server` integration (JSON-RPC, thread/turn/model/skills methods).
- IM-first operator flow (Discord + Telegram).
- Local single-host deployment (no relay/control plane required).
- Approval-gated risky operations and allowlist-based access control.
- Persistent bindings, thread mapping, approvals, and audit logs.

## Architecture

- `packages/core-runtime`: app-server process lifecycle + JSON-RPC client.
- `packages/im-gateway`: Discord/Telegram adapters + IM command parsing.
- `packages/state-store`: local config/state/audit persistence.
- `packages/ops-cli`: daemon orchestration, runtime wiring, CLI commands.

Reference projects are kept in `ref/` for lookup only.

## Requirements

- macOS or Linux
- Node.js 24 LTS or newer
- `codex` CLI installed and authenticated (`codex login`)
- Discord and/or Telegram bot credentials

## Install

```bash
git clone https://github.com/zycheny/codex-remote.git
cd codex-remote
npm ci
```

Optional global command:

```bash
npm link
reco help
```

## Quick Start

1. Run interactive setup:

```bash
./reco setup
```

2. Start daemon:

```bash
./reco start
./reco status
```

3. Bind a channel:

```bash
./reco bind discord
# or
./reco bind telegram <chatId> --user <userId>
```

4. In your IM chat:

```text
/status
/new
/ask summarize this repo
```

If settings change, restart:

```bash
./reco restart
```

## CLI Commands

Core:

- `reco setup`
- `reco start|stop|restart|status`
- `reco logs [lines]`
- `reco logs chat [lines]`
- `reco doctor`
- `reco help [command]`

Bindings and policy:

- `reco bind <channel> [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]`
- `reco unbind <channel> <chatId>`
- `reco policy set <channel> <chatId> [--approval <mode>] [--auto-approve <bool>] [--allowlist <csv>] [--model <id>] [--effort <level>] [--mode <name>]`

Discord diagnostics:

- `reco discord channels`
- `reco discord verify`

Thread admin:

- `reco threads list`
- `reco threads resume <threadId> --channel <name> --chat <id>`
- `reco resume <threadId> <channel> <chatId>`

## IM Commands

Namespaced commands:

- `/thread start|resume|list|more|read|fork|loaded|unsubscribe|archive|unarchive|compact|rollback`
- `/turn ask|steer|interrupt|review`
- `/model show|list|set|effort|mode`
- `/skills list|use|enable|disable|reload`

Shortcuts/aliases:

- `/new`, `/ask`, `/resume`, `/interrupt`, `/stop`
- `/threads`, `/archive`, `/status`, `/help`, `/approve`, `/cwd`

## Security Model

- Allowlist required per channel/binding before command execution.
- Approval required by default for command/file/tool approval requests.
- Local secrets/config stored with strict file permissions.
- Audit and chat-history logs are local-only.

## Runtime Paths

Default base directory: `~/.im-codex-tool`

- Config: `~/.im-codex-tool/config.json`
- Bindings/state: `~/.im-codex-tool/data/`
- Daemon log: `~/.im-codex-tool/logs/daemon.log`
- Chat history log: `~/.im-codex-tool/logs/chat-history.jsonl`

Override base dir with `IM_CODEX_HOME`.

## CI and Quality

- `npm test` (node test runner)
- `npm run test:coverage`
- `npm run ci` (tests)

GitHub Actions CI runs tests on Node 24/25.

## Development

```bash
npm ci
npm test
```

Contribution and commit conventions:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [AGENTS.md](AGENTS.md)

## Documentation

- Docs index: [references/README.md](references/README.md)
- Architecture: [references/architecture.md](references/architecture.md)
- Setup: [references/setup-guides.md](references/setup-guides.md)
- Usage: [references/usage.md](references/usage.md)
- Troubleshooting: [references/troubleshooting.md](references/troubleshooting.md)
- Token validation: [references/token-validation.md](references/token-validation.md)

## License

MIT - see [LICENSE](LICENSE).
