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
    channel: "discord",
    chatId: "123",
    userId: "u1",
    workingDir: "/tmp",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["u1"],
      autoApprove: false,
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
      collaborationMode: "default",
      skillsContext: {
        cwd: "/tmp",
        lastListedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  const store2 = new StateStore({ baseDir: dir });
  const binding = store2.getBinding("discord", "123");
  assert.equal(binding.channel, "discord");
  assert.deepEqual(binding.policyProfile.allowlist, ["u1"]);
  assert.equal(binding.policyProfile.model, "gpt-5.3-codex");
  assert.equal(binding.policyProfile.reasoningEffort, "medium");
  assert.equal(binding.policyProfile.collaborationMode, "default");
  assert.equal(binding.policyProfile.skillsContext.cwd, "/tmp");
});

test("pending approval create and resolve", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.createPendingApproval({
    localRequestId: "req-1",
    serverRequestId: "srv-1",
    method: "item/commandExecution/requestApproval",
    binding: { channel: "discord", chatId: "1" },
  });

  let pending = store.getPendingApprovals();
  assert.equal(Boolean(pending["req-1"]), true);

  store.resolvePendingApproval("req-1", { decision: "allow" });
  pending = store.getPendingApprovals();
  assert.equal(pending["req-1"].status, "resolved");
});

test("default config uses home directory as workingDir", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });
  const config = store.readConfig();
  assert.equal(config.defaults.workingDir, os.homedir());
});

test("upsert binding preserves extended policy fields on partial updates", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "c1",
    userId: "u1",
    workingDir: "/tmp",
    policyProfile: {
      approvalMode: "on-request",
      allowlist: ["u1"],
      autoApprove: false,
      model: "gpt-5.4",
      reasoningEffort: "high",
      collaborationMode: "default",
      skillsContext: {
        cwd: "/tmp",
        count: 1,
      },
    },
  });

  store.upsertBinding({
    channel: "discord",
    chatId: "c1",
    policyProfile: {
      approvalMode: "never",
      allowlist: ["u1", "u2"],
    },
  });

  const binding = store.getBinding("discord", "c1");
  assert.equal(binding.policyProfile.approvalMode, "never");
  assert.deepEqual(binding.policyProfile.allowlist, ["u1", "u2"]);
  assert.equal(binding.policyProfile.model, "gpt-5.4");
  assert.equal(binding.policyProfile.reasoningEffort, "high");
  assert.equal(binding.policyProfile.collaborationMode, "default");
  assert.equal(binding.policyProfile.skillsContext.cwd, "/tmp");
});
