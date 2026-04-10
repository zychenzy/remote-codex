# Usage Guide

This guide covers day-to-day operation after installation and setup.

## 1) Start and check daemon

```bash
./reco start
./reco status
./reco logs 100
```

If config changed:

```bash
./reco restart
```

If you run `reco` under `launchd` or `systemd`, use the service manager for restart/status instead of `./reco start`.

## 2) Bind chats to Codex sessions

Bind Discord (auto-infers IDs when unambiguous):

```bash
./reco bind discord
```

Change workspace later:

```text
/cwd ~/my-repo
```

## 3) Typical IM workflow

```text
/status
/new
/ask summarize this repository
/turn steer focus on tests only
/stop
```

Thread management:

```text
/thread list
/thread list all 30
/thread more
/resume <threadId>
/thread archive <threadId> --confirm
```

When you `/resume <threadId>`, daemon sends a formatted transcript window (last 3 turns by default) back to IM in chunked messages.

Model and skills:

```text
/model show
/model list
/model set gpt-5.4
/model effort set high
/skills list
/skills use skill-creator draft a release helper skill
```

Autopilot controls:

```text
/plan on
/plan off
/plan show
/autopilot status
/autopilot continue
```

Autopilot is intended for bounded continuation after a turn completes. Risky tool actions still flow through the normal approval policy.

## 4) Policy tuning

```bash
./reco policy set discord <chatId> \
  --approval on-request \
  --auto-approve false \
  --allowlist <userId1>,<userId2> \
  --model gpt-5.4 \
  --effort high \
  --mode default
```

## 5) Logs and diagnostics

Daemon log:

```bash
./reco logs 200
```

Chat history log:

```bash
./reco logs chat 200
```

Health checks:

```bash
./reco doctor
```

`reco doctor` is also the quickest way to catch multiple live daemon processes attached to the same state directory, which can cause duplicate turns and mixed Codex auth/account behavior.
