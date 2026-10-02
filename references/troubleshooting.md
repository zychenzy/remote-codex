# Troubleshooting

## 1) Daemon not running / stale PID

```bash
./reco status
./reco restart
```

If status shows not running but PID file exists, `reco restart` will cleanly recover.

If you run under `launchd` or `systemd`, check the service manager too.

## 2) `doctor` reports Codex issues

```bash
codex --version
codex login
./reco doctor
```

If `codex app-server` cannot start, verify your Codex installation and auth.

## 3) Duplicate turns, repeated "Working on it", or wrong Codex account

These symptoms usually mean more than one `reco` daemon is attached to the same `IM_CODEX_HOME`.

Check:

```bash
./reco doctor
./reco status
```

Typical signs:

- repeated `Working on it...` for one user message
- repeated `Recent activity` or tool summaries
- old or unexpected `codex login` account behavior
- abnormal token usage

If `reco doctor` reports multiple daemon processes, stop the extra instance and restart the managed service cleanly. On macOS `launchd`, do not keep using `./reco start` for the same state directory after the service is installed.

## 4) Discord connected but no replies

- Verify bot token and intents
- Verify channel IDs (`reco discord verify`)
- Verify your user ID is in allowlist
- Check logs:

```bash
./reco logs 200
./reco logs chat 200
```

Common Discord error:

- `Unknown Channel (code 10003)` means configured channel ID is wrong/inaccessible.
- Deleted channels and missing access/permissions now produce an actionable
  adapter error; restore bot access or update configuration and rebind.
- Gateway readiness times out after 30 seconds instead of waiting indefinitely.
  Check the token, Message Content Intent, and network, then restart.
- Authorized slash commands are acknowledged before daemon work begins. A
  deferred reply can finish after Discord's initial three-second deadline.

The adapter targets discord.js 14.27.0 or newer within v14. It uses `clientReady`,
message flags for private replies, and callback responses for reply IDs. Output
does not trigger user, role, or everyone mentions. Deleted source messages do
not prevent subsequent replies from being sent.

References: [discord.js interaction options](https://discord.js.org/docs/packages/discord.js/14.27.0/InteractionReplyOptions:Interface),
[Discord interaction deadlines](https://docs.discord.com/developers/interactions/receiving-and-responding).

## 5) `thread not found` in logs

This can happen when a stored thread is stale/unavailable in runtime.
The daemon has stale-thread recovery on ask/start flows, but you can also:

```text
/new
/ask <prompt>
```

## 6) Approval requests time out

- Pending approvals expire (default: 5 minutes)
- Approve quickly from IM:

```text
/approve <requestId> allow
```

If expired, run the request again.

## 7) Model/skill command returns unsupported method

Your local `codex app-server` may be older than the command surface in this project.
Upgrade Codex and retry.
