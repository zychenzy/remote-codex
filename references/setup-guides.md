# Setup Guides

`reco setup` is interactive, but your bot/channel provisioning must be done first.

## Prerequisites

- Node.js 24+
- `codex` installed and logged in (`codex login`)
- Discord bot token for your target server

## Quick bootstrap

```bash
./reco setup
./reco start
./reco status
```

After setup, run:

```bash
./reco doctor
```

If this machine should run `reco` continuously, switch from `./reco start` to an OS-managed service after initial verification.

## Discord setup

1. Create app + bot:
- Open <https://discord.com/developers/applications>
- Create application
- Open `Bot` tab and create/reset bot token

2. Enable intent:
- In `Bot` settings, enable `Message Content Intent`

3. Invite bot:
- Open `OAuth2` -> `URL Generator`
- Scopes: `bot`, `applications.commands`
- Permissions: `View Channels`, `Send Messages`, `Read Message History`, `Embed Links`; add `Send Messages in Threads` when using threads
- Invite to target server

4. Collect IDs:
- Bot token
- Text channel ID(s) where the bot should accept Gateway messages
- Allowed user ID(s) for command execution

Tip: enable Discord Developer Mode to copy IDs.

5. Run setup:
- `Enable Discord?` -> `y`
- Paste Discord bot token
- Set Discord allowlist user IDs (csv)
- Set Discord allowed channel IDs (csv)

6. Optional diagnostics:

```bash
./reco discord channels
./reco discord verify
```

7. Bind:

```bash
./reco bind discord
```

If multiple channel IDs exist, specify one:

```bash
./reco bind discord <channelId>
```

## Discord DM setup

Allowlisted users can operate the daemon in DM without keeping a server channel bound.

1. Keep Discord enabled and keep the allowlist populated during `reco setup`
2. Leave server `allowed channel IDs` empty if you want DM-only operation
3. Start or restart the daemon
4. Send a DM to the bot from an allowlisted Discord user
5. Bind that DM chat if needed:

```bash
./reco bind discord <dmChannelId>
```

The adapter receives messages and interactions through the Discord Gateway,
including uncached DM channels. It does not poll DM history. Restart after
changing the configured channel or user allowlists.

If the old bot was deleted, create a replacement and run setup with its new
token. If only the old channel was deleted, remove its ID from configuration
and bind an accessible channel or DM. `npm test` tests the adapter with local
Gateway and interaction fixtures and does not require either credential.

## Recommended macOS service setup

On macOS, prefer a user `LaunchAgent` that runs `daemon-run` directly:

```xml
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/Users/you/remote-codex/packages/ops-cli/src/cli.js</string>
  <string>daemon-run</string>
</array>
```

Why this shape:

- `daemon-run` is the foreground long-running process
- `reco start` is only a detached convenience wrapper
- a service manager should supervise the real foreground process, not the wrapper

Useful lifecycle commands:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.reco.plist
launchctl print gui/$(id -u)/local.reco
launchctl kickstart -k gui/$(id -u)/local.reco
launchctl bootout gui/$(id -u)/local.reco
```

If you use `launchd`, avoid mixing that with repeated manual `./reco start` runs against the same `IM_CODEX_HOME`.

## Workspace defaults and overrides

- Setup default workspace: chosen during `reco setup` (defaults to `~`).
- Per-binding override:

```bash
./reco bind discord --cwd ~/my-repo
```

- Runtime override from IM:

```text
/cwd ~/my-repo
```
