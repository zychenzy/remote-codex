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
  constructor({ loadedThreadIds = [] } = {}) {
    this.loadedThreadIds = loadedThreadIds;
    this.handlers = new Map();
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

  async readThread({ threadId }) {
    return { thread: { id: threadId, cwd: "/Users/czy/auto" } };
  }

  async respondServerRequest() {}
}

class StubDiscordAdapter {
  constructor() {
    this.channel = "discord";
    this.messages = [];
    this.streamingDeltas = [];
    this.approvalPrompts = [];
  }

  async start() {}

  async stop() {}

  async sendMessage(context, text) {
    this.messages.push({ context, text: String(text || "") });
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
  const historyPath = app.chatHistoryPath;
  const historyText = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, "utf8") : "";
  assert.equal(historyText.includes("```diff"), false);
  assert.equal(historyText.includes("src/example.js"), false);
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
