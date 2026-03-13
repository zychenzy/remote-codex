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

## 4) `thread not found` in logs

This can happen when a stored thread is stale/unavailable in runtime.
The daemon has stale-thread recovery on ask/start flows, but you can also:

```text
/new
/ask <prompt>
```

## 5) Approval requests time out

- Pending approvals expire (default: 5 minutes)
- Approve quickly from IM:

```text
/approve <requestId> allow
```

If expired, run the request again.

## 6) Model/skill command returns unsupported method

Your local `codex app-server` may be older than the command surface in this project.
Upgrade Codex and retry.
