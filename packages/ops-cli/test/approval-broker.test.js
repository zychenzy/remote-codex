import test from "node:test";
import assert from "node:assert/strict";

import { ApprovalBroker } from "../src/approval-broker.js";

test("approval broker resolves pending request once", async () => {
  const broker = new ApprovalBroker({ timeoutMs: 5000 });

  const created = broker.create({
    serverRequest: {
      id: "srv-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1" },
    },
    binding: { channel: "telegram", chatId: "1" },
    autoApprove: false,
  });

  assert.equal(created.autoResolved, false);

  const once = await new Promise((resolve) => {
    broker.once("resolved", resolve);
    const first = broker.resolve(created.record.localRequestId, { decision: "allow", actor: "user-1" });
    assert.equal(Boolean(first), true);
    const second = broker.resolve(created.record.localRequestId, { decision: "deny", actor: "user-2" });
    assert.equal(second, null);
  });

  assert.equal(once.response.decision, "accept");
});

test("approval broker times out to deny", async () => {
  const broker = new ApprovalBroker({ timeoutMs: 40 });

  broker.create({
    serverRequest: {
      id: "srv-timeout",
      method: "item/fileChange/requestApproval",
      params: { threadId: "t2" },
    },
    binding: { channel: "discord", chatId: "2" },
    autoApprove: false,
  });

  const result = await new Promise((resolve) => {
    broker.once("resolved", resolve);
  });

  assert.equal(result.timeout, true);
  assert.equal(result.response.decision, "decline");
});
