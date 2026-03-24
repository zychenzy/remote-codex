import test from "node:test";
import assert from "node:assert/strict";

import { BaseAdapter } from "../src/index.js";

class StubAdapter extends BaseAdapter {
  constructor() {
    super({ channel: "stub" });
    this.messages = [];
  }

  async sendMessage(context, text) {
    this.messages.push({ context, text });
  }
}

class FailingAdapter extends BaseAdapter {
  constructor(logger) {
    super({ channel: "failing", logger });
  }

  async sendMessage() {
    throw new Error("send failed");
  }
}

test("sendApprovalPrompt emits formatted approval instructions", async () => {
  const adapter = new StubAdapter();
  await adapter.sendApprovalPrompt(
    { channel: "stub", chatId: "1" },
    { localRequestId: "abc", kind: "item/commandExecution/requestApproval", summary: "run command" }
  );

  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.messages[0].text.includes("/approve abc allow"), true);
});

test("sendApprovalPrompt emits tool question instructions with /answer", async () => {
  const adapter = new StubAdapter();
  await adapter.sendApprovalPrompt(
    { channel: "stub", chatId: "1" },
    {
      localRequestId: "req-tool",
      kind: "item/tool/requestUserInput",
      summary: "Plan needs choices",
      questions: [
        {
          id: "mode",
          question: "Which mode?",
          options: [{ label: "fast" }, { label: "safe" }],
        },
      ],
    }
  );

  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.messages[0].text.includes("User input required"), true);
  assert.equal(adapter.messages[0].text.includes("Q1 [mode] Which mode?"), true);
  assert.equal(adapter.messages[0].text.includes("options: 1.fast | 2.safe"), true);
  assert.equal(adapter.messages[0].text.includes("quick: /answer req-tool rec"), true);
  assert.equal(adapter.messages[0].text.includes("/answer req-tool"), true);
});

test("base adapter coalesces streaming deltas into message output", async () => {
  const adapter = new StubAdapter();
  await adapter.sendStreamingDelta({ channel: "stub", chatId: "1", turnId: "t1" }, "hello");
  await adapter.sendStreamingDelta({ channel: "stub", chatId: "1", turnId: "t1" }, " world");
  await new Promise((resolve) => setTimeout(resolve, 950));
  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.messages[0].text, "hello world");
});

test("base adapter catches async flush errors from sendMessage", async () => {
  const logs = [];
  const logger = {
    error: (line) => logs.push(String(line || "")),
  };
  const adapter = new FailingAdapter(logger);
  await adapter.sendStreamingDelta({ channel: "failing", chatId: "1", turnId: "t2" }, "hello");
  await new Promise((resolve) => setTimeout(resolve, 950));
  assert.equal(logs.length >= 1, true);
  assert.equal(logs.some((line) => line.includes("failed to flush streaming delta")), true);
});
