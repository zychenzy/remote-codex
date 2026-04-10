# Autopilot Implementation Checklist

## Scope

This checklist turns the supervisor idea into a concrete v1 implementation for `~/auto`.

Goals for v1:

- keep all control inside the existing `~/auto` daemon
- do not depend on Hermes or OpenClaw
- add a supervisor with `rules` mode first
- make remote model supervision optional later
- keep the design aligned with the official `codex app-server` contract

## Ground Rules

- `~/auto` remains the only `codex app-server` client
- approvals still resolve through `ApprovalBroker`
- after `turn/completed`, use a fresh `turn/start`
- only use `turn/steer` while a turn is still active
- supervisor decisions must be from a tiny fixed action set:
  - `allow`
  - `deny`
  - `answer`
  - `continue`
  - `pause`

## v1 Delivery

### Phase 1: `rules` mode only

Ship only these behaviors:

1. observe app-server events already available in `DaemonApp`
2. auto-resolve low-risk approval requests using deterministic rules
3. auto-answer simple `item/tool/requestUserInput` requests using deterministic rules
4. optionally continue after `turn/completed` using a fresh `turn/start`
5. pause and notify Discord for everything else

Do not ship in phase 1:

- Hermes integration
- OpenClaw integration
- model-based supervision
- answer memory across arbitrary prompts
- automatic continuation without strict limits

## Exact Files To Add

- `packages/ops-cli/src/autopilot-supervisor.js`
- `packages/ops-cli/src/autopilot-policy.js`
- `packages/ops-cli/src/autopilot-rules.js`
- `packages/ops-cli/src/autopilot-format.js`
- `packages/ops-cli/test/autopilot-supervisor.test.js`
- `packages/ops-cli/test/autopilot-policy.test.js`

## Exact Files To Update

- `packages/state-store/src/index.js`
- `packages/im-gateway/src/command-parser.js`
- `packages/ops-cli/src/daemon-app.js`
- `packages/ops-cli/src/cli.js`
- `README.md`
- `references/README.md`

## Minimal Data Model

Extend `binding.policyProfile` with:

```json
{
  "autopilot": {
    "enabled": false,
    "mode": "rules",
    "continueOnTurnComplete": false,
    "maxAutomaticTurns": 5,
    "maxConsecutivePauses": 2,
    "commandAllowPrefixes": [
      "pwd",
      "ls",
      "rg ",
      "git status",
      "npm test",
      "pnpm test"
    ],
    "allowedWriteRoots": [],
    "toolInputStrategy": "recommended_only"
  }
}
```

Suggested defaults:

- `enabled: false`
- `mode: "rules"`
- `continueOnTurnComplete: false`
- `maxAutomaticTurns: 5`
- `maxConsecutivePauses: 2`
- `allowedWriteRoots: [binding.workingDir]`

## New State Store Methods

Add support in `packages/state-store/src/index.js` for:

- reading and writing normalized `policyProfile.autopilot`
- optional autopilot runtime session state:
  - `getAutopilotSessions()`
  - `getAutopilotSession(bindingKey)`
  - `upsertAutopilotSession(session)`
  - `deleteAutopilotSession(bindingKey)`

Store file:

- `data/autopilot-sessions.json`

Session shape:

```json
{
  "discord:1234": {
    "bindingKey": "discord:1234",
    "threadId": "thr_123",
    "activeTurnId": "turn_456",
    "status": "idle",
    "automaticTurns": 0,
    "consecutivePauses": 0,
    "lastAction": null,
    "updatedAt": "2026-04-09T00:00:00.000Z"
  }
}
```

## Supervisor Interface

Add `packages/ops-cli/src/autopilot-supervisor.js` with a single class:

```js
export class AutopilotSupervisor {
  constructor(deps) {}

  onServerRequest(serverRequest, context) {}
  onTurnStarted(params, context) {}
  onTurnCompleted(params, context) {}
  onItemStarted(params, context) {}
  onItemCompleted(params, context) {}
  onCommandOutputDelta(params, context) {}
}
```

Constructor dependencies should be explicit:

- `store`
- `runtime`
- `approvalBroker`
- `logger`
- `sendMessage`
- `startTurnWithRecovery`
- `getBindingByThreadId`
- `getAdapter`

## Policy Module

Add `packages/ops-cli/src/autopilot-policy.js`.

Expose pure functions:

```js
export function shouldHandleWithAutopilot(binding) {}
export function decideApproval(request, binding) {}
export function decideToolInput(request, binding) {}
export function decideTurnContinuation(snapshot, binding) {}
```

Return shape:

```json
{
  "action": "allow",
  "reason": "command prefix allowlisted",
  "payload": null
}
```

## Rules Module

Add `packages/ops-cli/src/autopilot-rules.js`.

v1 rules only:

### Approval rules

Allow only if all are true:

- autopilot enabled
- mode is `rules`
- request is `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`
- thread maps to a binding
- cwd is inside `binding.workingDir` or configured `allowedWriteRoots`
- command prefix matches `commandAllowPrefixes`
- request is not a network approval
- request is not destructive

Deny or pause if any are true:

- `networkApprovalContext` exists
- command contains:
  - `git reset --hard`
  - `git clean -fd`
  - `git checkout --`
  - `rm -rf`
- file change requests a path outside allowed roots

### Tool-input rules

Answer only if all are true:

- autopilot enabled
- questions are structured
- every question has options
- operator can safely choose first option via `rec`

Otherwise pause.

### Turn continuation rules

Continue only if all are true:

- `continueOnTurnComplete` is enabled
- turn status is `completed`
- no pending approvals for the binding
- no failure status
- automatic turn count is below limit
- last assistant text strongly suggests another obvious next step

v1 heuristic examples:

- continue when the last assistant text includes:
  - `next I will`
  - `next step`
  - `I will now`
- pause when the last assistant text includes:
  - `please confirm`
  - `which option`
  - `need your input`
  - `I am blocked`

## Formatting Module

Add `packages/ops-cli/src/autopilot-format.js` for short operator-facing messages:

- `formatAutopilotAction(decision)`
- `formatAutopilotPause(reason)`
- `formatAutopilotStatus(session, binding)`

Keep these messages short enough for Discord.

## `DaemonApp` Integration Points

Update `packages/ops-cli/src/daemon-app.js`.

### 1. Construct supervisor

Inside constructor:

- create `this.autopilotSupervisor`

### 2. Feed runtime events into supervisor

In `#handleRuntimeNotification(notification)`:

- on `turn/started` call supervisor hook
- on `item/started` call supervisor hook
- on `item/completed` call supervisor hook
- on `item/commandExecution/outputDelta` call supervisor hook
- on `turn/completed` call supervisor hook

In `#handleServerRequest(serverRequest)`:

- ask supervisor first
- if supervisor resolves the request, skip Discord prompt
- otherwise continue current behavior

Important:

- keep `ApprovalBroker` as the only path that actually resolves app-server requests
- supervisor should call `approvalBroker.resolve(...)`, not `runtime.respondServerRequest(...)` directly

### 3. Add continuation helper

Add a helper that starts a fresh follow-up turn after `turn/completed`.

Suggested prompt:

`Continue with the next concrete step. Do not ask for confirmation unless required by policy.`

Guardrails:

- only one auto-follow-up in flight per binding
- debounce for `500-1000ms`
- stop after `maxAutomaticTurns`

## Command Parser Changes

Update `packages/im-gateway/src/command-parser.js`.

Add:

- `/autopilot on`
- `/autopilot off`
- `/autopilot status`
- `/autopilot continue on`
- `/autopilot continue off`

Return shape example:

```js
{ type: "autopilot", action: "on", args: [] }
```

## `DaemonApp` Command Handling

Add handling in `packages/ops-cli/src/daemon-app.js` for:

- `autopilot on`
- `autopilot off`
- `autopilot status`
- `autopilot continue on`
- `autopilot continue off`

Behavior:

- update binding policy
- send confirmation message
- initialize or clear autopilot session state as needed

## CLI Changes

Update `packages/ops-cli/src/cli.js`.

Add support for:

- `reco policy set <channel> <chatId> --autopilot <on|off>`
- `reco policy set <channel> <chatId> --autopilot-mode <rules>`
- `reco policy set <channel> <chatId> --autopilot-continue <on|off>`

Update help text accordingly.

## Tests To Add

### `autopilot-policy.test.js`

- allows safe command approval inside workspace
- pauses network approval
- pauses destructive command
- pauses file change outside allowed root
- answers `recommended` tool-input prompt
- pauses ambiguous tool-input prompt
- continues only for safe completed turn

### `autopilot-supervisor.test.js`

- auto-resolves approval without Discord prompt
- falls back to Discord prompt when rules cannot decide
- auto-starts a fresh follow-up turn after `turn/completed`
- respects max automatic turn limit
- ignores failed turns

### `daemon-app` integration tests

Extend existing daemon notification tests for:

- `/autopilot on`
- `/autopilot off`
- autopilot status message
- approval server request handled automatically
- turn-complete continuation starts a new turn

## Suggested Commit Sequence

1. `feat: add autopilot policy config normalization`
2. `feat: add rules-based autopilot supervisor`
3. `feat: add autopilot IM and CLI commands`
4. `test: add autopilot approval and continuation coverage`
5. `docs: add autopilot usage notes`

## Practical v1 Boundaries

Keep v1 narrow:

- approvals: yes
- simple tool questions: yes
- obvious next-turn continuation: yes
- external supervisor model: no
- Hermes/OpenClaw integration: no

That gets you a working unattended mode quickly while keeping the blast radius small.

## v2 Hook For Hermes / OpenClaw / Small GPT

After v1 lands, add an optional decision-provider interface:

```js
export class DecisionProvider {
  async decide(packet) {}
}
```

Packet shape should stay tiny:

```json
{
  "kind": "approval|tool_input|turn_complete",
  "threadId": "thr_123",
  "turnId": "turn_456",
  "cwd": "/Users/czy/projects/foo",
  "summary": "approval required",
  "lastAgentText": "tests failed in api.spec.ts",
  "command": "npm test",
  "questions": []
}
```

Response shape:

```json
{
  "action": "allow|deny|answer|continue|pause",
  "reason": "short explanation",
  "payload": {}
}
```

This keeps token usage low and lets you plug in:

- a small GPT model
- Hermes
- OpenClaw

without changing the daemon's core control flow.
