# IM-First Codex Remote Control Tool

A local-first daemon that controls `codex app-server` from IM channels.

## v1 scope

- Runtime: `codex app-server` only
- Channels: Telegram + Discord
- Control surface: CLI-only
- Deployment: single host (no relay/control-plane required)

## Quick start

```bash
./reco setup
./reco start
./reco status
```

## CLI

```bash
./reco setup
./reco start
./reco stop
./reco restart
./reco status
./reco logs
./reco doctor
./reco bind telegram 123456 --user 123456 --cwd /path/to/repo
./reco bind discord
./reco unbind telegram 123456
./reco threads list
./reco threads resume <threadId> --channel telegram --chat 123456
./reco policy set telegram 123456 --approval on-request --auto-approve false
```

You can optionally run `npm link` once in this repo and then use `reco ...`
without `./`.

## Notes

- Secrets are stored under `~/.im-codex-tool/config.json` with mode `0600`.
- Daemon logs are in `~/.im-codex-tool/logs/daemon.log`.
- Discord setup walkthrough: `references/setup-guides.md`.
- `bind discord` auto-uses configured Discord channel/user defaults when unambiguous.
- Default workspace for new setup is your home directory (`~`).
- In chat, use `/cwd <path>` to update the binding workspace directory.
- Reference repos are kept under `./ref/Claude-to-IM-skill` and `./ref/remodex`.
- Developer and commit conventions are documented in `AGENTS.md` and `CONTRIBUTING.md`.
