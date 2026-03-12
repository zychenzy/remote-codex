# IM-First Codex Remote Control Tool

A local-first daemon that controls `codex app-server` from IM channels.

## v1 scope

- Runtime: `codex app-server` only
- Channels: Telegram + Discord
- Control surface: CLI-only
- Deployment: single host (no relay/control-plane required)

## Quick start

```bash
npm run tool -- setup
npm run tool -- start
npm run tool -- status
```

## CLI

```bash
npm run tool -- setup
npm run tool -- start
npm run tool -- stop
npm run tool -- status
npm run tool -- logs
npm run tool -- doctor
npm run tool -- bind telegram 123456 --user 123456 --cwd /path/to/repo
npm run tool -- unbind telegram 123456
npm run tool -- threads list
npm run tool -- threads resume <threadId> --channel telegram --chat 123456
npm run tool -- policy set telegram 123456 --approval on-request --auto-approve false
```

## Notes

- Secrets are stored under `~/.im-codex-tool/config.json` with mode `0600`.
- Daemon logs are in `~/.im-codex-tool/logs/daemon.log`.
- Discord setup walkthrough: `references/setup-guides.md`.
- Reference repos are kept under `./ref/Claude-to-IM-skill` and `./ref/remodex`.
- Developer and commit conventions are documented in `AGENTS.md` and `CONTRIBUTING.md`.
