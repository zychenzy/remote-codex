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
    threads.set(id, { id, turns: [] });
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
        threads: [...threads.values()].map((t) => ({ id: t.id })),
      },
    });
    return;
  }

  if (method === "turn/start") {
    const threadId = msg.params?.threadId;
    if (!threads.has(threadId)) {
      send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      return;
    }

    const turnId = `turn-${turnCounter++}`;
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

  if (method === "turn/interrupt") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }

  if (msg.id && !method) {
    send({ method: "serverRequest/resolved", params: { requestId: msg.id } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    return;
  }

  send({ id: msg.id, result: {} });
});
