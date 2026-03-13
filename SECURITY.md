# Security

## Local secrets

- Config is stored in `~/.im-codex-tool/config.json`.
- File mode is enforced to `0600`.

## Access control

- Discord allowlist gates inbound command handling.
- Command/file change approvals default to explicit user confirmation.

## Logging

- Tokens are redacted before writing logs.
- Audit events are persisted in local state files.
