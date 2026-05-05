# remote-codex

IM-first remote control daemon for Codex, backed by `codex app-server`.

This project lets you run Codex on your host machine and control it from Discord, while keeping operations local and policy-gated.

Allowlisted Discord users can also operate the bot via direct message; the daemon resolves and polls their DM channels at startup. DM-only operation is supported.

## Highlights

- Native `codex app-server` integration (JSON-RPC, thread/turn/model/skills methods).
- IM-first operator flow (Discord).
- Discord server channels and Discord DMs share the same binding, approval, and thread model.
- Discord turns now send direct live status/tool progress updates during execution and reply-anchor the final assistant output back to the triggering user message.
- Discord-native workspace and file navigation with `/cwd`, `/files`, and recursive `/search`.
- Optional autopilot continuation for safe follow-up turns, still bounded by local policy.
- Local single-host deployment (no relay/control plane required).
- Approval-gated risky operations and allowlist-based access control.
- Persistent bindings, thread mapping, approvals, and audit logs.

## Architecture

- `packages/core-runtime`: app-server process lifecycle + JSON-RPC client.
- `packages/im-gateway`: Discord adapter + IM command parsing.
- `packages/state-store`: local config/state/audit persistence.
- `packages/ops-cli`: daemon orchestration, runtime wiring, CLI commands.

System view (module-first, non-Mermaid):

```text
+-----------------------+
| Discord Adapter       |
| (im-gateway)          |
+-----------+-----------+
            |
            v
        +---+--------------------------------------------+
        |           Daemon Orchestrator (ops-cli)         |
        | - command routing (/thread,/turn,/model,/skills)|
        | - binding allowlist + approval gating            |
        | - thread/turn maps + chat streaming              |
        +--------------------+-----------------------------+
                             |
                             v
        +--------------------+-----------------------------+
        |      Runtime Engine (core-runtime)               |
        | - starts/stops codex app-server                  |
        | - JSON-RPC request/response + notifications      |
        +--------------------+-----------------------------+
                             |
                             v
                   +---------+---------+
                   | codex app-server  |
                   +-------------------+

        +-----------------------------------------------+
        | State Store (state-store)                     |
        | config.json / bindings.json / approvals.json  |
        | sessions.json / audit.jsonl / daemon logs     |
        +-----------------------------------------------+
```

Reference projects are kept in `ref/` for lookup only.

## Requirements

- macOS or Linux
- Node.js 24 LTS or newer
- `codex` CLI installed and authenticated (`codex login`)
- Discord bot credentials

## Install

```bash
git clone https://github.com/zycheny/remote-codex.git
cd remote-codex
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
```

4. In your IM chat:

```text
/status
/new
/ask summarize this repo
/cwd
/files
/search daemon-app
```

Allowlisted users can send the same commands in a Discord DM after the daemon restarts with the updated config.

If settings change, restart:

```bash
./reco restart
```

## Recommended Service Setup

For an always-on machine, let the OS supervise `daemon-run` directly.

- macOS: use a user `LaunchAgent`
- Linux: use a user or system `systemd` unit
- Do not point a service manager at `reco start`, because `reco start` is already a detached wrapper

macOS `LaunchAgent` shape:

```xml
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/Users/you/remote-codex/packages/ops-cli/src/cli.js</string>
  <string>daemon-run</string>
</array>
```

With `launchd`, prefer `launchctl` for lifecycle control:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.reco.plist
launchctl print gui/$(id -u)/local.reco
launchctl kickstart -k gui/$(id -u)/local.reco
launchctl bootout gui/$(id -u)/local.reco
```

## DM-Only Operation

If you no longer want server-channel polling:

- remove old server channel IDs from Discord config
- keep your Discord allowlist user IDs
- bind the DM chat instead of a server text channel
- restart the daemon so the active poll set matches config

DM-only setups still use the same thread, approval, and audit flow as server-channel bindings.

## Autopilot

Autopilot is an optional continuation mode for follow-up turns after a completion. It is designed to keep safe progress moving without removing the default approval model for risky actions.

Useful IM commands:

- `/plan on`
- `/plan off`
- `/plan show`
- `/autopilot status`
- `/autopilot continue`

## CLI Commands

Core:

- `reco setup`
- `reco start|stop|restart|status`
- `reco logs [lines]`
- `reco logs chat [lines]`
- `reco doctor`
- `reco help [command]`

Bindings and policy:

- `reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]`
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
- `/model show|set|effort|mode`
- `/skills list|use|enable|disable|reload`

Shortcuts/aliases:

- `/new`, `/ask`, `/resume`, `/interrupt`, `/stop`
- `/threads`, `/archive`, `/status`, `/help`, `/approve`, `/cwd`, `/files`, `/search`

Discord-native navigation:

- `/cwd` opens a subdirectory picker for the current workspace on Discord.
- `/files` opens a file browser rooted at the current workspace. Selecting a directory enters it immediately; selecting a file enables `Preview`.
- `/search <pattern>` searches the current workspace recursively for matching file paths and lets you preview a selected result.

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
