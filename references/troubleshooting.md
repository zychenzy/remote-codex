# Troubleshooting

## 1) Daemon not running / stale PID

```bash
./reco status
./reco restart
```

If status shows not running but PID file exists, `reco restart` will cleanly recover.

## 2) `doctor` reports Codex issues

```bash
codex --version
codex login
./reco doctor
```

If `codex app-server` cannot start, verify your Codex installation and auth.

## 3) Discord connected but no replies

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

## 4) Telegram connected but no replies

- Confirm token is valid
- Confirm chat ID and user ID are correct
- Check allowlist in config
- Restart daemon after config updates

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

## 8) Desktop sync not working

- Feature is disabled by default
- Enable per binding:

```bash
./reco policy set discord <chatId> --desktop-sync true
./reco restart
```

- On non-macOS, provide custom command with `IM_CODEX_DESKTOP_SYNC_COMMAND`.
