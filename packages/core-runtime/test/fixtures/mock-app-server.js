#!/usr/bin/env node
import readline from "node:readline";

let initialized = false;
const threads = new Map();
let threadCounter = 1;
let turnCounter = 1;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const method = msg.method;

  if (method === "initialize") {
    if (initialized) {
      send({ id: msg.id, error: { code: -32600, message: "already initialized" } });
      return;
    }
    initialized = true;
    send({ id: msg.id, result: { userAgent: "mock-app-server" } });
    return;
  }

  if (method === "initialized") {
    return;
  }

  if (method === "thread/start") {
    const id = `thread-${threadCounter++}`;
    threads.set(id, { id, cwd: msg.params?.cwd || process.cwd(), turns: [] });
    send({
      id: msg.id,
      result: {
        thread: { id },
        approvalPolicy: msg.params?.approvalPolicy || "on-request",
        cwd: msg.params?.cwd || process.cwd(),
        model: "gpt-5.3-codex",
        modelProvider: "openai",
        sandbox: { type: "workspaceWrite" },
      },
    });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }

  if (method === "thread/resume") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    send({
      id: msg.id,
      result: {
        thread: { id },
        approvalPolicy: "on-request",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        modelProvider: "openai",
        sandbox: { type: "workspaceWrite" },
      },
    });
    return;
  }

  if (method === "thread/list") {
    send({
      id: msg.id,
      result: {
        threads: [...threads.values()].map((t) => ({ id: t.id, cwd: t.cwd || process.cwd(), status: { type: "idle" } })),
        nextCursor: null,
      },
    });
    return;
  }

  if (method === "thread/read") {
    const id = msg.params?.threadId;
    const includeTurns = Boolean(msg.params?.includeTurns);
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    const thread = threads.get(id);
    send({
      id: msg.id,
      result: {
        thread: {
          id,
          name: thread.name || null,
          cwd: thread.cwd || process.cwd(),
          status: { type: "idle" },
          turns: includeTurns ? [...thread.turns] : undefined,
        },
      },
    });
    return;
  }

  if (method === "thread/fork") {
    const sourceId = msg.params?.threadId;
    if (!threads.has(sourceId)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    const id = `thread-${threadCounter++}`;
    const source = threads.get(sourceId);
    threads.set(id, { id, cwd: source.cwd || process.cwd(), turns: [...(source.turns || [])] });
    send({ id: msg.id, result: { thread: { id, cwd: source.cwd || process.cwd() } } });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }

  if (method === "thread/loaded/list") {
    send({ id: msg.id, result: { data: [...threads.keys()] } });
    return;
  }

  if (method === "thread/unsubscribe") {
    send({ id: msg.id, result: { status: "unsubscribed" } });
    send({ method: "thread/status/changed", params: { threadId: msg.params?.threadId, status: { type: "notLoaded" } } });
    send({ method: "thread/closed", params: { threadId: msg.params?.threadId } });
    return;
  }

  if (method === "thread/archive") {
    send({ id: msg.id, result: {} });
    send({ method: "thread/archived", params: { threadId: msg.params?.threadId } });
    return;
  }

  if (method === "thread/unarchive") {
    const id = msg.params?.threadId;
    const thread = threads.get(id) || { id, cwd: process.cwd(), turns: [] };
    threads.set(id, thread);
    send({ id: msg.id, result: { thread: { id, cwd: thread.cwd || process.cwd() } } });
    send({ method: "thread/unarchived", params: { threadId: id } });
    return;
  }

  if (method === "thread/compact/start") {
    send({ id: msg.id, result: {} });
    return;
  }

  if (method === "thread/rollback") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    send({ id: msg.id, result: { thread: { id, name: null, ephemeral: false } } });
    return;
  }

  if (method === "thread/name/set") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    const name = msg.params?.name || null;
    threads.get(id).name = name;
    send({ id: msg.id, result: { thread: { id, name } } });
    send({ method: "thread/name/updated", params: { threadId: id, name } });
    return;
  }

  if (method === "thread/goal/get") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    send({ id: msg.id, result: { goal: threads.get(id).goal || null } });
    return;
  }

  if (method === "thread/goal/set") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    const goal = msg.params?.goal || null;
    threads.get(id).goal = goal;
    send({ id: msg.id, result: { goal } });
    send({ method: "thread/goal/updated", params: { threadId: id, goal } });
    return;
  }

  if (method === "thread/goal/clear") {
    const id = msg.params?.threadId;
    if (!threads.has(id)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    threads.get(id).goal = null;
    send({ id: msg.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId: id } });
    return;
  }

  if (method === "turn/start") {
    const threadId = msg.params?.threadId;
    if (typeof msg.params?.collaborationMode === "string") {
      send({
        id: msg.id,
        error: {
          code: -32600,
          message: "Invalid request: invalid type: string \"plan\", expected struct CollaborationMode",
        },
      });
      return;
    }
    if (!threads.has(threadId)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }

    const turnId = `turn-${turnCounter++}`;
    threads.get(threadId).turns.push({ id: turnId });
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });

    send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "hello" } });

    if (msg.params?.input?.[0]?.text?.includes("needs approval")) {
      send({
        id: `approval-${turnId}`,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: `item-${turnId}`,
          command: "echo hi",
          reason: "test",
        },
      });
      return;
    }

    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }

  if (method === "turn/steer") {
    send({ id: msg.id, result: { turnId: msg.params?.expectedTurnId || null } });
    return;
  }

  if (method === "review/start") {
    const threadId = msg.params?.threadId;
    if (!threads.has(threadId)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    const turnId = `turn-${turnCounter++}`;
    send({
      id: msg.id,
      result: {
        turn: { id: turnId, status: "inProgress", items: [], error: null },
        reviewThreadId: threadId,
      },
    });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    return;
  }

  if (method === "turn/interrupt") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }

  if (method === "model/list") {
    send({
      id: msg.id,
      result: {
        data: [{
          id: "gpt-5.4",
          model: "gpt-5.4",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        }],
        nextCursor: null,
      },
    });
    return;
  }

  if (method === "collaborationMode/list") {
    send({
      id: msg.id,
      result: {
        data: [
          { mode: "default" },
          { mode: "plan" },
        ],
      },
    });
    return;
  }

  if (method === "skills/list") {
    const cwd = msg.params?.cwds?.[0] || process.cwd();
    send({
      id: msg.id,
      result: {
        data: [{
          cwd,
          skills: [
            {
              name: "skill-creator",
              path: "/tmp/skill-creator/SKILL.md",
              enabled: true,
              scope: "user",
            },
          ],
          errors: [],
        }],
      },
    });
    return;
  }

  if (method === "skills/config/write") {
    send({ id: msg.id, result: { ok: true, path: msg.params?.path, enabled: msg.params?.enabled } });
    send({ method: "skills/changed", params: {} });
    return;
  }

  if (method === "account/rateLimits/read") {
    send({
      id: msg.id,
      result: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1731547200 },
          rateLimitReachedType: null,
          planType: "plus",
        },
      },
    });
    return;
  }

  if (method === "configRequirements/read") {
    send({
      id: msg.id,
      result: {
        requirements: {
          allowedApprovalPolicies: ["onRequest", "unlessTrusted"],
          allowedSandboxModes: ["readOnly", "workspaceWrite"],
          featureRequirements: { unified_exec: true },
          network: { enabled: false, allowedDomains: ["api.openai.com"] },
        },
      },
    });
    return;
  }

  if (msg.id && !method) {
    send({ method: "serverRequest/resolved", params: { requestId: msg.id } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    return;
  }

  send({ id: msg.id, result: {} });
});
