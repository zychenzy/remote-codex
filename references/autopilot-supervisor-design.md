# Autopilot Supervisor Design

## Summary

Add an optional "autopilot supervisor" layer to the existing remote Codex daemon so a bound chat can keep progressing through long tasks without waiting on a human to watch every turn, approval prompt, or tool input request.

The design keeps the current architecture intact:

- `codex app-server` stays the runtime backend
- Discord stays the operator channel
- current binding, thread, and approval persistence stay in `state-store`

The new layer sits between runtime events and user-facing prompts. Its job is to decide whether to:

- auto-approve
- auto-answer a tool input request
- auto-steer the next turn
- escalate to Discord
- stop safely

## Why This Fits The Current Codebase

The current daemon already has the core hooks needed:

- `packages/core-runtime/src/app-server-runtime.js`
  - streams notifications
  - surfaces server requests
  - already opts into `experimentalApi`
- `packages/ops-cli/src/daemon-app.js`
  - maps threads to bindings
  - handles `turn/*` and `item/*`
  - already routes approvals through `ApprovalBroker`
- `packages/ops-cli/src/approval-broker.js`
  - centralizes server request resolution
  - already supports `item/tool/requestUserInput`
- `packages/state-store/src/index.js`
  - persists bindings, pending approvals, sessions, and audit logs

This means the design can be implemented mostly as a policy-and-orchestration extension, not a rewrite.

## Goals

- Let approved chats run unattended for long stretches.
- Auto-handle routine command/file approvals under a policy.
- Auto-answer structured tool input prompts when confidence is high.
- Detect when Codex has reached a local stopping point and continue with the next turn.
- Escalate only when policy, confidence, or risk requires it.
- Preserve crash recovery, auditability, and remote operator visibility.

## Non-Goals

- Fully removing all safety controls.
- Bypassing Codex/runtime policy in undocumented ways.
- Replacing Discord with a separate control plane.
- Letting a secondary model perform arbitrary direct code execution outside the daemon policy.

## Proposed Model

Add a new per-binding capability called `autopilot`.

When enabled, each binding gets a lightweight state machine:

1. `idle`
2. `running_turn`
3. `waiting_approval_decision`
4. `waiting_tool_input_decision`
5. `waiting_followup_decision`
6. `escalated`
7. `stopped`

The daemon remains the only process talking to `codex app-server`. The supervisor is an internal subsystem inside `ops-cli`, not a separate daemon at first.

## High-Level Architecture

```text
Discord inbound command
  -> DaemonApp
  -> AppServerRuntime
  -> codex app-server
  -> runtime notifications / server requests
  -> AutopilotSupervisor
     -> PolicyEngine
     -> AnswerEngine
     -> ContinuationEngine
     -> EscalationEngine
  -> ApprovalBroker / turn control
  -> Discord outbound updates
  -> StateStore / audit log
```

## Core Components

### 1. `AutopilotSupervisor`

New orchestration module in `packages/ops-cli/src/autopilot-supervisor.js`.

Responsibilities:

- subscribe to runtime events already handled by `DaemonApp`
- maintain ephemeral per-binding run state
- invoke policy checks
- trigger approve/deny/answer/steer actions
- rate-limit and debounce follow-up actions
- persist key decisions and checkpoints

### 2. `PolicyEngine`

New module in `packages/ops-cli/src/autopilot-policy.js`.

Responsibilities:

- evaluate whether a request is safe to auto-resolve
- classify events into:
  - `allow`
  - `deny`
  - `escalate`
  - `continue`
  - `stop`
- apply per-binding rules and thread-scoped overrides

Initial policy inputs:

- binding policy profile
- request type
- command path/prefix
- cwd
- file paths touched
- tool input question shape
- current turn summary
- recent error history

### 3. `AnswerEngine`

New module in `packages/ops-cli/src/autopilot-answer-engine.js`.

Responsibilities:

- answer `item/tool/requestUserInput` requests
- start with deterministic rules first
- optionally call a secondary model only when deterministic rules do not apply

Deterministic first-pass rules:

- if a question has a recommended/default option and policy allows it, choose it
- if a question is a known repeated prompt, reuse the last accepted answer for the same binding/workspace/tool
- if the operator set a binding-level preference, use it

Secondary model usage:

- input: structured question payload, recent turn context, binding policy, workspace metadata
- output: normalized answer payload plus confidence and rationale
- gating: only accept if confidence passes threshold and the answer respects policy constraints

### 4. `ContinuationEngine`

New module in `packages/ops-cli/src/autopilot-continuation.js`.

Responsibilities:

- detect when Codex finished one local subtask and needs a follow-up turn
- decide whether to call `turn/steer` or start a new `turn/start`
- apply stop conditions

Continuation triggers:

- `turn/completed` with no unresolved approvals
- final assistant text contains an explicit local completion marker
- a structured output schema says there is another step to run
- a known workflow mode expects iterative progress

Example continuation prompts:

- "Continue with the next concrete step. Do not stop to ask for confirmation unless policy requires it."
- "Resolve the test failures you just found and continue."
- "Apply the recommended option and proceed."

### 5. `EscalationEngine`

New module in `packages/ops-cli/src/autopilot-escalation.js`.

Responsibilities:

- send concise Discord prompts only when human input is necessary
- include why autopilot paused
- include what choices were considered
- provide a resumable action path

## Policy Shape

Extend `binding.policyProfile` with an `autopilot` block:

```json
{
  "autopilot": {
    "enabled": true,
    "mode": "supervised",
    "approvalStrategy": "policy",
    "answerStrategy": "rules_then_model",
    "continuationStrategy": "turn_followup",
    "maxAutomaticTurns": 12,
    "maxRuntimeMinutes": 90,
    "maxConsecutiveFailures": 3,
    "commandAllowPrefixes": ["git status", "npm test", "pnpm test", "ls", "rg "],
    "fileWriteRoots": ["/Users/czy/projects"],
    "escalateOn": ["secret_access", "outside_workspace_write", "destructive_git"],
    "secondaryModel": "gpt-5.4-mini",
    "secondaryModelConfidenceThreshold": 0.8
  }
}
```

Suggested modes:

- `off`
  - current behavior
- `observe`
  - log what autopilot would have done, but do not act
- `supervised`
  - auto-handle low-risk cases, escalate the rest
- `full`
  - auto-handle everything allowed by policy, still stop on hard guards

## Event Handling Design

### A. Approval requests

Current flow:

- runtime server request
- `ApprovalBroker.create(...)`
- Discord prompt
- human resolves it

New flow:

- runtime server request
- `AutopilotSupervisor.evaluateServerRequest(...)`
- if decision is `allow` or `deny`, resolve via `ApprovalBroker.resolve(...)`
- if decision is `answer`, resolve tool payload via `ApprovalBroker.resolve(...)`
- if decision is `escalate`, keep current Discord prompt path

This preserves one resolution path and keeps `ApprovalBroker` as the source of truth.

### B. Turn completion

On `turn/completed`:

1. collect final turn text, last plan update, diff summary, and recent command results
2. run continuation policy
3. if `continue`, schedule a delayed new `turn/start`
4. if `stop`, mark autopilot session completed
5. if `escalate`, send a concise summary to Discord and await operator input

Use a short debounce, for example `500-1500ms`, to avoid racing with late item notifications.

Important:

- `turn/steer` is only for an active in-flight turn.
- after `turn/completed`, follow-up work should use a fresh `turn/start`.

### C. Command output observation

For long-running work, use existing `item/commandExecution/outputDelta` handling as an input signal.

Useful detections:

- test suite finished with failures
- package install completed
- build succeeded
- build failed
- command is waiting for stdin or interactive input

If a command appears interactive or blocked, escalate immediately instead of trying to guess.

## State And Persistence

Persist autopilot session state in a new store file:

- `data/autopilot-sessions.json`

Suggested shape:

```json
{
  "discord:123456": {
    "enabled": true,
    "status": "running_turn",
    "threadId": "thr_123",
    "activeTurnId": "turn_456",
    "startedAt": "2026-04-09T00:00:00.000Z",
    "automaticTurns": 4,
    "consecutiveFailures": 0,
    "lastDecision": {
      "type": "approval_allow",
      "at": "2026-04-09T00:12:00.000Z"
    }
  }
}
```

Persist reusable answer memory in:

- `data/autopilot-answer-memory.json`

This stores safe repeated answers keyed by:

- binding
- workspace root
- tool/request shape hash

## Discord UX

Autopilot should be visible but not noisy.

Add commands:

- `/autopilot on`
- `/autopilot off`
- `/autopilot status`
- `/autopilot mode <observe|supervised|full>`
- `/autopilot limits`
- `/autopilot answer-memory clear`

Suggested message patterns:

- start:
  - `Autopilot enabled for this thread in supervised mode.`
- automatic action:
  - `Autopilot approved command execution: npm test`
- escalation:
  - `Autopilot paused: file change touches path outside allowed roots. Reply /approve <id> to continue.`
- completion:
  - `Autopilot stopped after 7 automatic turns: task reached a stable stopping point.`

## Safety Guards

Hard-stop even in `full` mode when any of these happens:

- command matches destructive git patterns:
  - `git reset --hard`
  - `git clean -fd`
  - `git checkout --`
- write/delete outside configured workspace roots
- secret/token file access outside explicit allowlist
- more than `N` consecutive failures
- same turn restarts repeatedly without progress
- tool-input question cannot be mapped confidently
- app-server/runtime returns overload or protocol errors repeatedly

## Secondary Model Strategy

Use a second model only for narrow bounded decisions, not for direct tool execution.

Recommended scope:

- classify tool input requests
- choose among listed options
- decide whether the assistant output implies "continue" vs "escalate"
- summarize why the daemon paused

Do not let the secondary model:

- run shell commands directly
- edit files directly
- bypass policy
- invent approval responses outside the request schema

## Implementation Plan

### Phase 1. Observe-only

- add `autopilot` policy shape
- add supervisor skeleton
- log what decisions would have been made
- do not auto-resolve anything

Success criteria:

- no behavior change when disabled
- decision logs are understandable
- false-positive continuation rate is low

### Phase 2. Auto-approve low-risk requests

- auto-resolve command/file approvals for allowlisted patterns
- keep Discord escalation for everything else

Success criteria:

- unattended progress improves on known tasks
- audit trail clearly records auto-decisions

### Phase 3. Auto-answer tool input

- add deterministic answer rules
- add answer memory
- optionally add secondary model evaluator

Success criteria:

- repeated prompts are handled without operator intervention
- low-confidence prompts still escalate

### Phase 4. Turn continuation

- add continuation policy at `turn/completed`
- support bounded follow-up turns

Success criteria:

- multi-step coding tasks continue meaningfully without manual nudging
- stop conditions are reliable

## Suggested File Changes

### New files

- `packages/ops-cli/src/autopilot-supervisor.js`
- `packages/ops-cli/src/autopilot-policy.js`
- `packages/ops-cli/src/autopilot-answer-engine.js`
- `packages/ops-cli/src/autopilot-continuation.js`
- `packages/ops-cli/src/autopilot-escalation.js`
- `packages/ops-cli/test/autopilot-supervisor.test.js`
- `packages/ops-cli/test/autopilot-policy.test.js`

### Existing files to extend

- `packages/state-store/src/index.js`
  - persist autopilot session state and answer memory
- `packages/ops-cli/src/daemon-app.js`
  - instantiate supervisor
  - feed runtime notifications and server requests into it
  - add `/autopilot` commands
- `packages/ops-cli/src/approval-broker.js`
  - keep as execution path for resolved approvals
  - optionally enrich resolution metadata with `source: user|autopilot`
- `packages/ops-cli/src/discord-turn-ux.js`
  - add concise autopilot status formatting helpers

## Recommended First Slice

Build the smallest useful slice first:

1. `observe` mode only
2. policy evaluation for command/file approval requests
3. auto-approve only when:
   - binding has autopilot enabled
   - request path is inside binding workspace
   - command matches an allowlisted prefix
4. Discord notice for every auto-approved action
5. audit log entry with machine-readable reason

That first slice should be enough to validate the architecture on your real remote workflows without risking runaway automation.

## Open Questions

- Should autopilot be enabled per binding, per thread, or both.
- Whether continuation prompts should always start a fresh `turn/start` after completion or allow the operator to choose different follow-up styles.
- Whether answer memory should be global or workspace-scoped.
- Whether the secondary model should run locally, via Hermes, or through Codex itself with a separate thread.

## Recommendation

Start with an in-process supervisor inside `ops-cli`, not a separate watcher service.

Reasons:

- your daemon already owns the runtime connection
- all needed events already pass through `DaemonApp`
- approvals already converge through one broker
- crash recovery and audit persistence are already present
- you can add a second model later without changing the core event path

If the feature proves valuable, the policy and answer engines can later be extracted into a separate service without changing the external Discord workflow.
