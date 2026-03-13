import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../src/index.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-store-"));
}

test("binding persistence across store reload", () => {
  const dir = tempDir();
  const store1 = new StateStore({ baseDir: dir });

  store1.upsertBinding({
    channel: "telegram",
    chatId: "123",
    userId: "u1",
    workingDir: "/tmp",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["u1"],
      autoApprove: false,
      desktopSyncEnabled: false,
    },
  });

  const store2 = new StateStore({ baseDir: dir });
  const binding = store2.getBinding("telegram", "123");
  assert.equal(binding.channel, "telegram");
  assert.deepEqual(binding.policyProfile.allowlist, ["u1"]);
});

test("pending approval create and resolve", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.createPendingApproval({
    localRequestId: "req-1",
    serverRequestId: "srv-1",
    method: "item/commandExecution/requestApproval",
    binding: { channel: "telegram", chatId: "1" },
  });

  let pending = store.getPendingApprovals();
  assert.equal(Boolean(pending["req-1"]), true);

  store.resolvePendingApproval("req-1", { decision: "allow" });
  pending = store.getPendingApprovals();
  assert.equal(pending["req-1"].status, "resolved");
});
