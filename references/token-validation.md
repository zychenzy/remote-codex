# Token Validation

This project validates channel credentials by performing lightweight API calls during normal adapter operation.

## Discord

- Validation occurs via Discord REST calls (for example channel read / message poll).
- Failures appear in daemon logs with HTTP status + API payload.
- Use:

```bash
./reco discord verify
```

to validate configured channel IDs against the current bot token.

## Telegram

- Validation occurs via Telegram Bot API calls (`getUpdates`, `sendMessage`).
- Token issues appear as adapter polling/sending errors in daemon logs.

## Security Notes

- Tokens are stored locally in `~/.im-codex-tool/config.json`.
- Config file is written with restrictive permissions (`0600` best-effort).
- Logs redact sensitive payloads where possible; avoid pasting raw tokens in chat.
