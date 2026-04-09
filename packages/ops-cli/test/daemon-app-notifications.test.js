import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DaemonApp } from "../src/daemon-app.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-daemon-test-"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeRuntime {
  constructor({ loadedThreadIds = [], threadReads = {} } = {}) {
    this.loadedThreadIds = loadedThreadIds;
    this.threadReads = new Map(Object.entries(threadReads));
    this.handlers = new Map();
    this.serverResponses = [];
    this.startTurnCalls = [];
  }

  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) || [];
      this.handlers.set(event, current.filter((candidate) => candidate !== handler));
    };
  }

  emit(event, payload) {
    const list = this.handlers.get(event) || [];
    for (const handler of list) {
      handler(payload);
    }
  }

  async initialize() {}

  async stop() {}

  async listLoadedThreads() {
    return { data: this.loadedThreadIds };
  }

  async readThread({ threadId, includeTurns = false }) {
    const existing = this.threadReads.get(threadId);
    if (existing) {
      return existing;
    }
    return {
      thread: {
        id: threadId,
        cwd: "/Users/czy/auto",
        ...(includeTurns ? { turns: [] } : {}),
      },
    };
  }

  async resumeThread(threadId) {
    const existing = this.threadReads.get(threadId);
    if (existing?.thread) {
      return {
        thread: {
          id: threadId,
          cwd: existing.thread.cwd || "/Users/czy/auto",
        },
      };
    }
    return { thread: { id: threadId, cwd: "/Users/czy/auto" } };
  }

  async startTurn(params) {
    this.startTurnCalls.push(params);
    const turnId = "turn-start-" + this.startTurnCalls.length;
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async respondServerRequest(requestId, result) {
    this.serverResponses.push({ requestId, result });
  }
}

class StubDiscordAdapter {
  constructor() {
    this.channel = "discord";
    this.messages = [];
    this.messageEdits = [];
    this.streamingDeltas = [];
    this.approvalPrompts = [];
    this.inboundHandler = null;
    this.nextMessageId = 1;
    this.failEdits = false;
  }

  registerInboundHandler(handler) {
    this.inboundHandler = handler;
  }

  emitInbound(context) {
    if (this.inboundHandler) {
      this.inboundHandler(context);
    }
  }

  async start() {}

  async stop() {}

  async sendMessage(context, text) {
    return this.sendMessageRich(context, { text });
  }

  async sendMessageRich(context, payload = {}) {
    const record = {
      context,
      text: String(payload.text || ""),
      replyToMessageId: payload.replyToMessageId || context.replyToMessageId || null,
      threadId: payload.threadId || context.threadId || null,
      messageId: `msg-${this.nextMessageId++}`,
    };
    this.messages.push(record);
    return { messageId: record.messageId, chatId: record.threadId || context.chatId };
  }

  async editMessage(context, messageId, text) {
    if (this.failEdits) {
      return null;
    }
    this.messageEdits.push({ context, messageId, text: String(text || "") });
    const existing = this.messages.find((item) => item.messageId === messageId);
    if (existing) {
      existing.text = String(text || "");
    }
    return { messageId, chatId: context.threadId || context.chatId };
  }

  async sendStreamingDelta(context, delta) {
    this.streamingDeltas.push({ context, delta: String(delta || "") });
  }

  async sendApprovalPrompt(context, payload) {
    this.approvalPrompts.push({ context, payload });
  }
}

async function setupDaemonHarness() {
  const baseDir = tempDir();
  const app = new DaemonApp({ baseDir });
  const runtime = new FakeRuntime({ loadedThreadIds: ["thread-1"] });
  const adapter = new StubDiscordAdapter();

  app.runtime = runtime;
  app.adapters.push(adapter);
  app.store.upsertBinding({
    channel: "discord",
    chatId: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["user-1"],
      autoApprove: false,
    },
  });

  await app.start();
  return { app, runtime, adapter };
}

test("daemon creates direct live status message and reply-anchors final assistant output", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask describe current status",
      messageId: "user-msg-1",
    });
    await sleep(40);

    assert.equal(adapter.messages.some((item) => item.text.includes("Working on it...")), true);
    assert.equal(adapter.messages.some((item) => item.text.includes("Working on it...") && !item.replyToMessageId), true);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-start-1", delta: "Live assistant text" },
    });
    await sleep(30);
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(30);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Live assistant text") && item.replyToMessageId === "user-msg-1"), true);
  assert.equal(adapter.messageEdits.some((item) => item.text.includes("Completed")), true);
});

test("daemon aggregates compact discord tool activity into one progress message", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask inspect tools",
      messageId: "user-msg-2",
    });
    await sleep(40);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });

    for (const item of [
      { id: "cmd-1", type: "commandExecution", command: "ls -la", cwd: "/tmp" },
      { id: "file-1", type: "fileChange", changes: [{ path: "src/a.js", kind: "modified" }] },
      { id: "mcp-1", type: "mcpToolCall", server: "docs", tool: "search", arguments: { q: "app-server" } },
      { id: "dyn-1", type: "dynamicToolCall", tool: "search_files", arguments: { pattern: "TODO" } },
    ]) {
      runtime.emit("notification", {
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-start-1", item },
      });
    }
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.messages[0].replyToMessageId, null);
  assert.equal(adapter.messages[0].text.includes("Working on it..."), true);
  assert.equal(adapter.messages[0].text.includes("Recent activity:"), true);
  assert.equal(adapter.messages[0].text.includes("- Terminal: `ls -la`"), true);
  assert.equal(adapter.messages[0].text.includes("- File changes proposed (1)"), true);
  assert.equal(adapter.messages[0].text.includes("- MCP tool: `docs/search`"), true);
  assert.equal(adapter.messages[0].text.includes("- Dynamic tool: `search_files`"), true);
  assert.equal(adapter.messageEdits.length >= 1, true);
});

test("daemon surfaces discord plan updates as separate messages", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask plan something",
      messageId: "user-msg-plan",
    });
    await sleep(40);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        explanation: "Working through the repo",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Draft response", status: "inProgress" },
        ],
      },
    });
    await sleep(30);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Plan update")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Inspect files")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Plan update") && item.replyToMessageId), false);
});

test("daemon ignores live terminal output deltas on discord", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask run command",
      messageId: "user-msg-3",
    });
    await sleep(40);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        item: { id: "cmd-tail-1", type: "commandExecution", command: "npm test", cwd: "/Users/czy/auto" },
      },
    });
    runtime.emit("notification", {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        itemId: "cmd-tail-1",
        delta: "line one\nline two\nline three\n",
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messageEdits.some((item) => item.text.includes("line three")), false);
  assert.equal(adapter.messages.some((item) => item.text.includes("line three")), false);
});

test("daemon keeps tool activity live and sends a single final reply after tool boundaries", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask split segments",
      messageId: "user-msg-4",
    });
    await sleep(40);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-start-1", delta: "Segment one" },
    });
    await sleep(30);
    runtime.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        item: { id: "cmd-boundary-1", type: "commandExecution", command: "rg todo", cwd: "/tmp" },
      },
    });
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-start-1", delta: "Segment two" },
    });
    await sleep(40);
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(30);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.filter((item) => item.text.includes("Segment")).length, 1);
  assert.equal(adapter.messages.some((item) => item.text.includes("Segment oneSegment two") && item.replyToMessageId === "user-msg-4"), true);
});

test("daemon sends discord assistant output only once at completion", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask no duplicate",
      messageId: "user-msg-5",
    });
    await sleep(40);

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-start-1", delta: "Already visible" },
    });
    await sleep(30);
    const messagesBeforeCompletion = adapter.messages.filter((item) => item.text.includes("Already visible")).length;
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(30);

    assert.equal(messagesBeforeCompletion, 0);
    assert.equal(adapter.messages.filter((item) => item.text.includes("Already visible")).length, 1);
  } finally {
    await app.stop();
  }
});

test("daemon does not append assistant output live when discord edits fail", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.discord.statusEditIntervalMs = 0;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask fallback path",
      messageId: "user-msg-6",
    });
    await sleep(40);
    adapter.failEdits = true;

    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-start-1" },
    });
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-start-1", delta: "Fallback assistant text\n\n" },
    });
    await sleep(40);
    assert.equal(adapter.messages.some((item) => item.text.includes("Fallback assistant text")), false);
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.filter((item) => item.text.includes("Fallback assistant text")).length, 1);
  assert.equal(adapter.messages.some((item) => item.text.includes("Fallback assistant text") && item.replyToMessageId === "user-msg-6"), true);
});

test("daemon reply-anchors approval prompts to the originating discord message", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask approval flow",
      messageId: "user-msg-approval",
    });
    await sleep(40);

    runtime.emit("serverRequest", {
      id: "srv-tool-approval",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-start-1",
        questions: [{ id: "mode", question: "Which mode?", options: ["fast", "safe"] }],
      },
    });
    await sleep(30);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.approvalPrompts.length, 1);
  assert.equal(adapter.approvalPrompts[0].context.replyToMessageId, "user-msg-approval");
});

test("daemon emits completed sections during turn and only sends pending tail on completion", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "```js\nconst a = 1;\n" },
    });
    await sleep(20);
    assert.equal(adapter.messages.length, 0);

    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        delta: `\`\`\`\n\nDone section.\n\n${"line text ".repeat(30)}\n\n`,
      },
    });
    await sleep(20);
    assert.equal(adapter.messages.length >= 1, true);
    assert.equal(adapter.messages.some((item) => item.text.includes("const a = 1;")), true);

    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "Tail that is not boundary-terminated" },
    });
    await sleep(20);

    const countBeforeCompletion = adapter.messages.length;
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(20);

    assert.equal(adapter.messages.length > countBeforeCompletion, true);
    assert.equal(
      adapter.messages.slice(countBeforeCompletion).some((item) => item.text.includes("Tail that is not boundary-terminated")),
      true
    );
    assert.equal(adapter.messages.some((item) => item.text.includes("Turn completed")), false);
  } finally {
    await app.stop();
  }
});

test("daemon soft-publishes long text without blank-line boundary", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  app.outputPolicy.turnOutputMinChunkChars = 2000;
  app.outputPolicy.turnOutputSoftChunkChars = 120;

  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-soft-1" },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-soft-1",
        delta: `${"word ".repeat(35)}\n${"more ".repeat(35)}\n`,
      },
    });
    await sleep(30);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("word")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("more")), true);
});

test("daemon suppresses interrupted turn errors from user-facing output", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-2" },
    });
    await sleep(20);

    app.suppressedTurnIds.add("turn-2");
    runtime.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-2", delta: "partial output\n\n" },
    });
    await sleep(20);
    assert.equal(adapter.messages.length, 0);

    runtime.emit("notification", {
      method: "error",
      params: { threadId: "thread-1", turnId: "turn-2", error: { message: "interrupted" } },
    });
    await sleep(20);

    assert.equal(adapter.messages.some((item) => item.text.includes("Runtime error:")), false);
  } finally {
    await app.stop();
  }
});

test("daemon does not emit completion message for suppressed turn with no pending output", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-3" },
    });
    await sleep(20);

    app.suppressedTurnIds.add("turn-3");
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-3",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(20);

    assert.equal(adapter.messages.some((item) => item.text.includes("Turn completed")), false);
  } finally {
    await app.stop();
  }
});

test("daemon emits file-change diffs as fenced code blocks without persisting them in chat-history log", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-5" },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "turn/diff/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-5",
        diff: "diff --git a/src/example.js b/src/example.js\n@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
      },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-5",
        item: {
          id: "file-1",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/example.js",
              kind: "modified",
              diff: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')",
            },
          ],
        },
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("```diff")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Turn diff (aggregated)")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("diff --git a/src/example.js b/src/example.js")), true);
  const historyPath = app.chatHistoryPath;
  const historyText = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, "utf8") : "";
  assert.equal(historyText.includes("```diff"), false);
  assert.equal(historyText.includes("src/example.js"), false);
});

test("daemon falls back to fileChange outputDelta when completed item has no diff field", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-6" },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/fileChange/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-6",
        itemId: "file-2",
        delta: "@@ -10,2 +10,3 @@\n-const oldValue = 1;\n+const oldValue = 2;\n+const added = true;",
      },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-6",
        item: {
          id: "file-2",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/fallback.js",
              kind: "modified",
              diff: "",
            },
          ],
        },
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Patch diff")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("+const added = true;")), true);
  const historyText = fs.existsSync(app.chatHistoryPath) ? fs.readFileSync(app.chatHistoryPath, "utf8") : "";
  assert.equal(historyText.includes("Patch diff"), false);
});

test("daemon summarizes whole-file add/remove changes with compact +/- placeholders", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-7" },
    });
    await sleep(20);

    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-7",
        item: {
          id: "file-3",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/new-file.js",
              kind: "added",
              diff: "@@ -0,0 +1,200 @@\n+const veryLarge = true;\n+more lines...",
            },
            {
              path: "src/old-file.js",
              kind: "deleted",
              diff: "@@ -1,200 +0,0 @@\n-const removed = true;\n-more lines...",
            },
          ],
        },
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Path: src/new-file.js (added)")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Path: src/old-file.js (deleted)")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("+ [full file content omitted]")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("- [full file content omitted]")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("+const veryLarge = true")), false);
  assert.equal(adapter.messages.some((item) => item.text.includes("-const removed = true")), false);
});

test("daemon does not resend replayed file-change item after restart", async () => {
  const baseDir = tempDir();

  const app1 = new DaemonApp({ baseDir });
  const runtime1 = new FakeRuntime({ loadedThreadIds: ["thread-1"] });
  const adapter1 = new StubDiscordAdapter();
  app1.runtime = runtime1;
  app1.adapters.push(adapter1);
  app1.store.upsertBinding({
    channel: "discord",
    chatId: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["user-1"],
      autoApprove: false,
    },
  });

  try {
    await app1.start();
    runtime1.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-replay-1" },
    });
    await sleep(20);
    runtime1.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-replay-1",
        item: {
          id: "file-replay-1",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/replay.js",
              kind: "modified",
              diff: "@@ -1 +1 @@\n-console.log('first')\n+console.log('second')",
            },
          ],
        },
      },
    });
    await sleep(40);
    assert.equal(adapter1.messages.some((item) => item.text.includes("src/replay.js")), true);
  } finally {
    await app1.stop();
  }

  const app2 = new DaemonApp({ baseDir });
  const runtime2 = new FakeRuntime({ loadedThreadIds: ["thread-1"] });
  const adapter2 = new StubDiscordAdapter();
  app2.runtime = runtime2;
  app2.adapters.push(adapter2);

  try {
    await app2.start();
    runtime2.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-replay-1" },
    });
    await sleep(20);
    runtime2.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-replay-1",
        item: {
          id: "file-replay-1",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/replay.js",
              kind: "modified",
              diff: "@@ -1 +1 @@\n-console.log('first')\n+console.log('second')",
            },
          ],
        },
      },
    });
    await sleep(40);
  } finally {
    await app2.stop();
  }

  assert.equal(adapter2.messages.some((item) => item.text.includes("src/replay.js")), false);
});

test("daemon requeues chat history after flush failure and persists after path recovery", async () => {
  const { app, runtime } = await setupDaemonHarness();
  const originalChatHistoryPath = app.chatHistoryPath;
  app.chatHistoryPath = app.store.logsDir;

  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-4" },
    });
    await sleep(20);
    runtime.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-4",
        turn: { status: { type: "completed" } },
      },
    });
    await sleep(320);
    app.chatHistoryPath = originalChatHistoryPath;
    await sleep(320);
  } finally {
    await app.stop();
  }

  const text = fs.readFileSync(app.chatHistoryPath, "utf8");
  assert.equal(text.includes("Turn completed (completed)."), true);
});

test("daemon delivers completed plan item text", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-plan-1" },
    });
    await sleep(20);
    runtime.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-plan-1",
        item: {
          id: "plan-item-1",
          type: "plan",
          text: "# Final plan\n- step 1\n- step 2",
        },
      },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("# Final plan")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("- step 1")), true);
});

test("daemon /resume sends thread history blocks through integrated command flow", async () => {
  const baseDir = tempDir();
  const app = new DaemonApp({ baseDir });
  const runtime = new FakeRuntime({
    loadedThreadIds: ["thread-history"],
    threadReads: {
      "thread-history": {
        thread: {
          id: "thread-history",
          cwd: "/Users/czy/auto",
          turns: [
            {
              items: [
                { type: "userMessage", content: [{ type: "text", text: "turn one user" }] },
                { type: "agentMessage", content: [{ type: "text", text: "turn one agent" }] },
              ],
            },
            {
              items: [
                { type: "userMessage", content: [{ type: "text", text: "turn two user" }] },
                { type: "agentMessage", content: [{ type: "text", text: "turn two agent" }] },
              ],
            },
            {
              items: [
                { type: "userMessage", content: [{ type: "text", text: "turn three user" }] },
                { type: "agentMessage", content: [{ type: "text", text: "turn three agent" }] },
              ],
            },
            {
              items: [
                { type: "userMessage", content: [{ type: "text", text: "turn four user" }] },
                { type: "agentMessage", content: [{ type: "text", text: "turn four agent" }] },
              ],
            },
          ],
        },
      },
    },
  });
  const adapter = new StubDiscordAdapter();

  app.runtime = runtime;
  app.adapters.push(adapter);
  app.store.upsertBinding({
    channel: "discord",
    chatId: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["user-1"],
      autoApprove: false,
    },
  });

  try {
    await app.start();
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/resume thread-history",
    });
    await sleep(900);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Resumed thread: thread-history")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Thread history (3/4 turns shown):")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Turn 2")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("User:\n> turn two user")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Assistant:\nturn four agent")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("turn one user")), false);
});

test("daemon /resume includes plan item text in thread history", async () => {
  const baseDir = tempDir();
  const app = new DaemonApp({ baseDir });
  const runtime = new FakeRuntime({
    loadedThreadIds: ["thread-plan-history"],
    threadReads: {
      "thread-plan-history": {
        thread: {
          id: "thread-plan-history",
          cwd: "/Users/czy/auto",
          turns: [
            {
              items: [
                { type: "plan", text: "# Plan from thread history\n- one\n- two" },
              ],
            },
          ],
        },
      },
    },
  });
  const adapter = new StubDiscordAdapter();

  app.runtime = runtime;
  app.adapters.push(adapter);
  app.store.upsertBinding({
    channel: "discord",
    chatId: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["user-1"],
      autoApprove: false,
    },
  });

  try {
    await app.start();
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/resume thread-plan-history",
    });
    await sleep(450);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Resumed thread: thread-plan-history")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("# Plan from thread history")), true);
});

test("daemon supports /cwd absolute, ~, and /workspace alias with resolved errors", async () => {
  const { app, adapter } = await setupDaemonHarness();
  const missing = `~/definitely-missing-${Date.now()}`;

  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/cwd /",
    });
    await sleep(50);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/cwd ~",
    });
    await sleep(50);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/workspace /tmp",
    });
    await sleep(50);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: `/cwd ${missing}`,
    });
    await sleep(60);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Workspace set to: /")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes(`Workspace set to: ${os.homedir()}`)), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Workspace set to: /tmp")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes(`Directory does not exist: ${missing}`)), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("(resolved: ")), true);
});

test("daemon /status includes auth inheritance note", async () => {
  const { app, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/status",
    });
    await sleep(50);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Auth mode: inherited from current Codex login state")), true);
});

test("daemon thread auto-approve handles command/file only and keeps tool user-input manual", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/approve auto on",
    });
    await sleep(60);

    runtime.emit("serverRequest", {
      id: "srv-auto-command-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-auto-1",
        reason: "run command",
      },
    });
    await sleep(60);

    runtime.emit("serverRequest", {
      id: "srv-auto-tool-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-auto-1",
        reason: "need user input",
      },
    });
    await sleep(60);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.messages.some((item) => item.text.includes("Thread auto-approve (command/file) enabled for thread-1")), true);
  assert.equal(runtime.serverResponses.some((item) => item.requestId === "srv-auto-command-1" && item.result?.decision === "accept"), true);
  assert.equal(runtime.serverResponses.some((item) => item.requestId === "srv-auto-tool-1"), false);
  assert.equal(adapter.approvalPrompts.length >= 1, true);
});

test("daemon thread auto-approve is scoped per thread and persists across restart", async () => {
  const baseDir = tempDir();

  const app1 = new DaemonApp({ baseDir });
  const runtime1 = new FakeRuntime({ loadedThreadIds: ["thread-1"] });
  const adapter1 = new StubDiscordAdapter();
  app1.runtime = runtime1;
  app1.adapters.push(adapter1);
  app1.store.upsertBinding({
    channel: "discord",
    chatId: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["user-1"],
      autoApprove: false,
    },
  });

  try {
    await app1.start();
    adapter1.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/approve auto on thread-1",
    });
    await sleep(80);
    app1.threadToBinding.set("thread-2", "discord:chat-1");
    runtime1.emit("serverRequest", {
      id: "srv-auto-thread2",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-2", reason: "run thread2 command" },
    });
    await sleep(60);
  } finally {
    await app1.stop();
  }

  const app2 = new DaemonApp({ baseDir });
  const runtime2 = new FakeRuntime({ loadedThreadIds: ["thread-1"] });
  const adapter2 = new StubDiscordAdapter();
  app2.runtime = runtime2;
  app2.adapters.push(adapter2);
  try {
    await app2.start();
    runtime2.emit("serverRequest", {
      id: "srv-auto-thread1-after-restart",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", reason: "file change" },
    });
    await sleep(60);
  } finally {
    await app2.stop();
  }

  assert.equal(runtime1.serverResponses.some((item) => item.requestId === "srv-auto-thread2"), false);
  assert.equal(adapter1.approvalPrompts.length >= 1, true);
  assert.equal(runtime2.serverResponses.some((item) => (
    item.requestId === "srv-auto-thread1-after-restart"
    && item.result?.decision === "accept"
  )), true);
});

test("daemon clears thread auto-approve toggle when thread is archived or closed", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/approve auto on thread-1",
    });
    await sleep(60);
    runtime.emit("notification", {
      method: "thread/archived",
      params: { threadId: "thread-1" },
    });
    await sleep(40);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/approve auto on thread-2",
    });
    await sleep(60);
    app.threadToBinding.set("thread-2", "discord:chat-1");
    runtime.emit("notification", {
      method: "thread/closed",
      params: { threadId: "thread-2" },
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  const binding = app.store.getBinding("discord", "chat-1");
  const map = binding?.policyProfile?.threadAutoApproveByThreadId || {};
  assert.equal(Boolean(map["thread-1"]), false);
  assert.equal(Boolean(map["thread-2"]), false);
});

test("daemon supports /plan on|off|show alias", async () => {
  const { app, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan on",
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan show",
    });
    await sleep(40);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan off",
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan show",
    });
    await sleep(40);
  } finally {
    await app.stop();
  }

  const binding = app.store.getBinding("discord", "chat-1");
  assert.equal(binding?.policyProfile?.collaborationMode ?? null, "default");
  assert.equal(adapter.messages.some((item) => item.text.includes("Plan mode enabled")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Plan mode is ON")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Plan mode disabled")), true);
  assert.equal(adapter.messages.some((item) => item.text.includes("Plan mode is OFF")), true);
});

test("daemon /model mode set default stores explicit default mode", async () => {
  const { app, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/model mode set default",
    });
    await sleep(60);
  } finally {
    await app.stop();
  }

  const binding = app.store.getBinding("discord", "chat-1");
  assert.equal(binding?.policyProfile?.collaborationMode ?? null, "default");
  assert.equal(adapter.messages.some((item) => item.text.includes("Mode set to: default")), true);
});

test("daemon sends explicit collaboration mode default after /plan off", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan on",
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask first turn",
    });
    await sleep(60);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/plan off",
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/ask second turn",
    });
    await sleep(60);
  } finally {
    await app.stop();
  }

  assert.equal(runtime.startTurnCalls.length >= 2, true);
  assert.equal(runtime.startTurnCalls[0]?.collaborationMode ?? null, "plan");
  assert.equal(runtime.startTurnCalls[1]?.collaborationMode ?? null, "default");
});

test("daemon /answer resolves latest tool user-input request in binding", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("serverRequest", {
      id: "srv-tool-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-tool-1",
        reason: "need plan answers",
        questions: [
          {
            id: "mode",
            question: "Pick mode",
            options: [{ label: "fast" }, { label: "safe" }],
          },
        ],
      },
    });
    await sleep(60);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/answer mode=fast",
    });
    await sleep(70);
  } finally {
    await app.stop();
  }

  assert.equal(adapter.approvalPrompts.length, 1);
  assert.equal(Array.isArray(adapter.approvalPrompts[0]?.payload?.questions), true);
  assert.equal(runtime.serverResponses.length >= 1, true);
  const response = runtime.serverResponses.find((item) => item.requestId === "srv-tool-input-1");
  assert.equal(Boolean(response), true);
  assert.deepEqual(response?.result, { answers: { mode: { answers: ["fast"] } } });
});

test("daemon /answer supports explicit request id and deny", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("serverRequest", {
      id: "srv-tool-input-a",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-tool-a",
        reason: "first prompt",
        questions: [{ id: "mode", question: "Pick mode", options: [{ label: "fast" }, { label: "safe" }] }],
      },
    });
    await sleep(40);
    runtime.emit("serverRequest", {
      id: "srv-tool-input-b",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-tool-b",
        reason: "second prompt",
        questions: [{ id: "mode", question: "Pick mode", options: [{ label: "fast" }, { label: "safe" }] }],
      },
    });
    await sleep(60);

    const firstLocal = adapter.approvalPrompts[0]?.payload?.localRequestId;
    const secondLocal = adapter.approvalPrompts[1]?.payload?.localRequestId;
    assert.equal(Boolean(firstLocal), true);
    assert.equal(Boolean(secondLocal), true);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: `/answer deny ${firstLocal}`,
    });
    await sleep(60);

    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: `/answer ${secondLocal} mode=safe`,
    });
    await sleep(70);
  } finally {
    await app.stop();
  }

  const denyResponse = runtime.serverResponses.find((item) => item.requestId === "srv-tool-input-a");
  const allowResponse = runtime.serverResponses.find((item) => item.requestId === "srv-tool-input-b");
  assert.deepEqual(denyResponse?.result, { answers: {} });
  assert.deepEqual(allowResponse?.result, { answers: { mode: { answers: ["safe"] } } });
});

test("daemon /answer supports recommended and numeric shorthand", async () => {
  const { app, runtime, adapter } = await setupDaemonHarness();
  try {
    runtime.emit("serverRequest", {
      id: "srv-tool-rec",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-tool-rec",
        questions: [
          { id: "delivery_path", question: "Delivery path?", options: [{ label: "dm" }, { label: "chat" }] },
          { id: "chapter_unit", question: "Chapter unit?", options: [{ label: "chapter" }, { label: "section" }] },
        ],
      },
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/answer rec",
    });
    await sleep(80);

    runtime.emit("serverRequest", {
      id: "srv-tool-num",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-tool-num",
        questions: [
          { id: "delivery_path", question: "Delivery path?", options: [{ label: "dm" }, { label: "chat" }] },
          { id: "chapter_unit", question: "Chapter unit?", options: [{ label: "chapter" }, { label: "section" }] },
        ],
      },
    });
    await sleep(60);
    adapter.emitInbound({
      channel: "discord",
      chatId: "chat-1",
      userId: "user-1",
      text: "/answer 2 1",
    });
    await sleep(80);
  } finally {
    await app.stop();
  }

  const recResponse = runtime.serverResponses.find((item) => item.requestId === "srv-tool-rec");
  const numResponse = runtime.serverResponses.find((item) => item.requestId === "srv-tool-num");
  assert.deepEqual(recResponse?.result, {
    answers: {
      delivery_path: { answers: ["dm"] },
      chapter_unit: { answers: ["chapter"] },
    },
  });
  assert.deepEqual(numResponse?.result, {
    answers: {
      delivery_path: { answers: ["chat"] },
      chapter_unit: { answers: ["chapter"] },
    },
  });
});
