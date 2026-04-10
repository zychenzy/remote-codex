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
