# Architecture

## Runtime model

- Single local daemon process
- Single Codex backend: `codex app-server`
- JSON-RPC transport over stdio
- IM adapters (Discord/Telegram) as ingress/egress channels

## Core modules

- `packages/core-runtime`
  - starts/stops app-server
  - handles initialize/initialized handshake
  - maps typed wrapper methods to JSON-RPC calls
  - emits notifications and server-initiated requests

- `packages/im-gateway`
  - channel adapters
  - inbound normalization into shared context shape
  - outbound messaging, streaming delta handling, approval prompts

- `packages/state-store`
  - local config (`config.json`)
  - binding/session/pending-approval persistence
  - audit logging

- `packages/ops-cli`
  - daemon orchestration
  - command routing and policy gating
  - approval broker and operator CLI

## Binding model

Each channel/chat binding stores:

- `threadId`
- `workingDir`
- policy profile:
  - `approvalMode`
  - `allowlist`
  - `autoApprove`
  - `desktopSyncEnabled`
  - `model`
  - `reasoningEffort`
  - `collaborationMode`

## Safety model

- allowlist check before command execution
- approval flow for command/file/tool requests
- confirmation gate for risky thread operations (`archive`, `rollback`, `compact`, `unarchive`)

## Observability

- daemon log: runtime lifecycle and adapter/runtime failures
- chat history log: inbound/outbound/streaming traces
- audit log: state transitions and approval events
