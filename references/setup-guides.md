# Setup guides

`tool setup` collects credentials interactively, but for Discord you still need
to configure the bot correctly in the Discord Developer Portal first.

## Discord setup (v1)

1. Create a bot app.
- Go to https://discord.com/developers/applications
- Create a new application.
- Open the **Bot** tab and create/reset the bot token.

2. Enable required privileged intent.
- In **Bot** settings, enable **Message Content Intent**.
- Save changes.

3. Invite bot to your server.
- Open **OAuth2** -> **URL Generator**.
- Select scope: `bot`.
- Select bot permissions: `View Channels`, `Send Messages`, `Read Message History`.
- Open generated URL and add the bot to your target server.

4. Collect IDs required by this project.
- `Discord Bot Token`: from Bot tab.
- `Allowed Channel IDs`: channels where polling should read messages.
- `Allowed User IDs`: users allowed to execute commands.

Tip: In Discord, enable **Developer Mode** in user settings, then right-click a
channel/user to copy IDs.

5. Run setup and provide Discord values.

```bash
npm run tool -- setup
```

When prompted:
- `Enable Discord?` -> `y`
- `Discord bot token` -> paste token
- `Discord allowlist user IDs` -> comma-separated user IDs
- `Discord allowed channel IDs for polling` -> comma-separated channel IDs

6. Start daemon and verify.

```bash
npm run tool -- start
npm run tool -- status
npm run tool -- logs
```

In an allowed channel, send:
- `/status`
- `/new`
- `/ask hello`

If there is no response, run:

```bash
npm run tool -- doctor
```

## Bind shortcut after setup

After setup, you can bind Discord without repeating IDs:

```bash
npm run tool -- bind discord
```

This auto-fills:
- `chatId` from configured `Discord allowed channel IDs` when exactly one is set.
- `userId` from configured Discord allowlist (first value).

If multiple channel IDs are configured, pass one explicitly:

```bash
npm run tool -- bind discord <channelId>
# or
npm run tool -- bind discord --chat <channelId>
```
