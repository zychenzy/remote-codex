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
    binding: { channel: "discord", chatId: "1" },
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

test("approval broker auto-approve routes through pending and resolves once", async () => {
  const broker = new ApprovalBroker({ timeoutMs: 5000 });
  const resolutions = [];
  broker.on("resolved", (resolution) => resolutions.push(resolution));

  const created = broker.create({
    serverRequest: {
      id: "srv-auto",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t3" },
    },
    binding: { channel: "discord", chatId: "3" },
    autoApprove: true,
  });

  assert.equal(created.autoResolved, true);
  // Auto-approve emits exactly one resolution via the shared resolve path.
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].decision, "allow");
  assert.equal(resolutions[0].response.decision, "accept");
  // The entry is removed from pending, so a second resolve is a no-op (single resolution).
  assert.equal(broker.getPending(created.record.localRequestId), null);
  assert.equal(broker.resolve(created.record.localRequestId, { decision: "deny", actor: "user-x" }), null);
  assert.equal(resolutions.length, 1);
});

test("approval broker blocks resolve by a non-initiator actor", async () => {
  const broker = new ApprovalBroker({ timeoutMs: 5000 });
  const resolutions = [];
  broker.on("resolved", (resolution) => resolutions.push(resolution));

  const created = broker.create({
    serverRequest: {
      id: "srv-owned",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t4" },
    },
    binding: { channel: "discord", chatId: "4" },
    autoApprove: false,
    initiatorUserId: "user-owner",
  });

  assert.equal(created.record.initiatorUserId, "user-owner");

  const blocked = broker.resolve(created.record.localRequestId, { decision: "allow", actor: "user-other" });
  assert.deepEqual(blocked, { notOwner: true });
  assert.equal(resolutions.length, 0);
  // Still pending: a later owner resolution must succeed.
  assert.notEqual(broker.getPending(created.record.localRequestId), null);

  const ok = broker.resolve(created.record.localRequestId, { decision: "allow", actor: "user-owner" });
  assert.equal(ok.decision, "allow");
  assert.equal(ok.initiatorUserId, "user-owner");
  assert.equal(resolutions.length, 1);
});

test("approval broker overrideOwnership bypasses initiator check (system actor)", () => {
  const broker = new ApprovalBroker({ timeoutMs: 5000 });

  const created = broker.create({
    serverRequest: {
      id: "srv-override",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t5" },
    },
    binding: { channel: "discord", chatId: "5" },
    autoApprove: false,
    initiatorUserId: "user-owner",
  });

  const resolution = broker.resolve(created.record.localRequestId, {
    decision: "allow",
    actor: "autopilot",
    overrideOwnership: true,
  });
  assert.equal(resolution.decision, "allow");
});

test("approval broker normalizes unrecognized decision to deny", () => {
  const broker = new ApprovalBroker({ timeoutMs: 5000 });

  const created = broker.create({
    serverRequest: {
      id: "srv-norm",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t6" },
    },
    binding: { channel: "discord", chatId: "6" },
    autoApprove: false,
  });

  const resolution = broker.resolve(created.record.localRequestId, { decision: "maybe", actor: "user" });
  // Raw value is normalized: anything other than "allow" becomes "deny".
  assert.equal(resolution.decision, "deny");
  assert.equal(resolution.response.decision, "decline");
});
