# App-server compatibility review — 2026-10-03

The repository's last commit was 2026-06-22. The host had Codex CLI 0.159.0;
the npm registry and upstream release page identified 0.160.0 as the latest
stable release during this review. The project now pins 0.160.0 as a development
dependency for repeatable protocol tests. The system-wide Codex installation
and live Discord configuration were not changed.

The daemon still launches `codex` from PATH. `npm start` includes the pinned
development binary in PATH; direct `./reco` and OS services use their configured
PATH. Check `codex --version` in the service environment when deploying.

## Compatibility changes

- Goal writes send `objective`, and goal messages read the structured response's
  `objective`. The existing `setThreadGoal({ threadId, goal })` call remains valid.
- Collaboration mode settings include the required model, resolved from thread
  start/resume responses or the default model catalog entry. Concurrent callers
  share one initialization handshake.
- `/fast` selects `serviceTier: "priority"`; disabling it explicitly sends null
  to reset the tier. It preserves reasoning effort. Old low-effort preferences
  are not automatically converted into a potentially billable priority setting.
- Permission requests use the existing owner-checked approval flow, show the
  requested permissions, and grant only the requested set for the current turn.
  They are never covered by the generic auto-approve switch. Denial or timeout
  returns an empty grant.
- Requests for user input without a binding return empty answers. Unsupported
  MCP elicitations are declined; dynamic tools return failure; unknown server
  methods return a JSON-RPC error instead of waiting indefinitely.
- `serverRequest/resolved` dismisses pending local approvals without replying
  again. Server replies no longer try to restart a disconnected process.
- The removed `persistExtendedHistory` field is omitted from thread/start.
- Compatible Discord dependency updates resolve the four advisories found in
  the original lockfile; npm audit reported zero vulnerabilities afterward.

## Validation and future upgrades

Run with Node 24 LTS or newer:

```bash
npm ci
npm test
npm run test:app-server
```

The integration test uses the real pinned Codex executable and a loopback
Responses SSE fixture with isolated temporary state. It verifies real protocol
parsing, goal management, plan/default modes without an explicitly selected
model, service-tier persistence/reset, streamed turns, server tool requests,
history reads, thread listing, and restart/resume. No Discord credentials or
external model access are required. Allowlist, ownership, approval denial and
timeout, and adapter behavior are covered by the unit suite.

These checks do not prove that a Discord bot/channel still exists, or that an
account can use a particular model or priority tier. Re-provision Discord with
`./reco setup` and use `./reco discord verify` before deployment.

On the next Codex upgrade, update the exact development dependency and generate
the schema from that executable, rather than relying solely on mocks:

```bash
./node_modules/.bin/codex app-server generate-json-schema --experimental --out /tmp/reco-schema
```

## Upstream and alternatives

[Codex 0.160.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.160.0)
include initialization error/SQLite fixes, provider catalog corrections, and
reconnection improvements. The protocol also now exposes richer history
pagination, permissions, MCP elicitation, and additional transports. This daemon
continues to use local stdio and its existing thread interface.
[App-server documentation](https://learn.chatgpt.com/docs/app-server).

Projects checked during this review:

| Project | Fit |
| --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | Broader agent workspace with desktop, web, and mobile interfaces and multiple providers; roughly 24.2k stars at review time. |
| [CodexMonitor](https://github.com/Dimillian/CodexMonitor) | Codex-focused workspace/thread UI with Git and worktree workflows; roughly 4.3k stars. |
| [Codex ACP](https://github.com/agentclientprotocol/codex-acp) | Maintained app-server adapter for ACP-compatible editors. Development moved here from zed-industries/codex-acp. |

Recommendation: retain this repository for its narrow local IM control and
approval model. Try an existing UI before expanding it into a general agent
workspace. Other useful app-server applications include local change review,
resumable repository maintenance, and a dashboard of tasks and pending approvals.
Those are suggested directions, not features added in this upgrade.
