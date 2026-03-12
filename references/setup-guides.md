# Setup Guides

`reco setup` is interactive, but your bot/channel provisioning must be done first.

## Prerequisites

- Node.js 24+
- `codex` installed and logged in (`codex login`)
- Bot token(s) for channel(s) you plan to use

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

## Discord setup

1. Create app + bot:
- Open <https://discord.com/developers/applications>
- Create application
- Open `Bot` tab and create/reset bot token

2. Enable intent:
- In `Bot` settings, enable `Message Content Intent`

3. Invite bot:
- Open `OAuth2` -> `URL Generator`
- Scope: `bot`
- Permissions: `View Channels`, `Send Messages`, `Read Message History`
- Invite to target server

4. Collect IDs:
- Bot token
- Text channel ID(s) where bot should poll
- Allowed user ID(s) for command execution

Tip: enable Discord Developer Mode to copy IDs.

5. Run setup:
- `Enable Discord?` -> `y`
- Paste Discord bot token
- Set Discord allowlist user IDs (csv)
- Set Discord allowed channel IDs for polling (csv)

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

## Telegram setup

1. Create bot with `@BotFather` and get token.
2. Get chat ID and user ID(s) allowed to control daemon.
3. Run setup:
- `Enable Telegram?` -> `y`
- Paste Telegram token
- Provide Telegram allowlist IDs (csv)
4. Bind:

```bash
./reco bind telegram <chatId> --user <userId>
```

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
