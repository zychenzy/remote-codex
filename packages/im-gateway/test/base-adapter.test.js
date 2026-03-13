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

test("sendApprovalPrompt emits formatted approval instructions", async () => {
  const adapter = new StubAdapter();
  await adapter.sendApprovalPrompt(
    { channel: "stub", chatId: "1" },
    { localRequestId: "abc", kind: "item/commandExecution/requestApproval", summary: "run command" }
  );

  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.messages[0].text.includes("/approve abc allow"), true);
});
