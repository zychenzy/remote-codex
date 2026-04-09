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
      threadAutoApproveByThreadId: {
        "thread-1": true,
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
  assert.equal(binding.policyProfile.threadAutoApproveByThreadId["thread-1"], true);
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
  assert.equal(config.defaults.output.resumeHistoryTurns, 5);
  assert.equal(config.defaults.output.chatHistoryFlushIntervalMs, 250);
  assert.equal(config.defaults.output.turnOutputMinChunkChars, 160);
  assert.equal(config.defaults.output.turnOutputSoftChunkChars, 280);
  assert.equal(config.defaults.output.liveSectionMaxLen, 1400);
  assert.equal(config.defaults.output.liveSectionDelayMs, 250);
  assert.equal(config.defaults.output.discord.replyToUser, true);
  assert.equal(config.defaults.output.discord.useLiveEdits, true);
  assert.equal(config.defaults.output.discord.statusEditIntervalMs, 500);
  assert.equal(config.defaults.output.discord.statusMessageMaxLen, 1600);
  assert.equal(config.defaults.output.discord.toolProgressMode, "compact");
  assert.equal(config.defaults.output.discord.toolOutputTailLines, 8);
  assert.equal(config.defaults.output.discord.finalMessageMaxLen, 1600);
  assert.equal(config.defaults.output.discord.finalMessageDelayMs, 350);
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
      threadAutoApproveByThreadId: {
        "thread-keep": true,
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
  assert.equal(binding.policyProfile.threadAutoApproveByThreadId["thread-keep"], true);
});

test("upsert binding supports explicit clearing of nullable policy fields", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "c2",
    policyProfile: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      collaborationMode: "plan",
      skillsContext: { cwd: "/tmp" },
    },
  });

  store.upsertBinding({
    channel: "discord",
    chatId: "c2",
    policyProfile: {
      model: null,
      reasoningEffort: null,
      collaborationMode: null,
      skillsContext: null,
    },
  });

  const binding = store.getBinding("discord", "c2");
  assert.equal(binding.policyProfile.model, null);
  assert.equal(binding.policyProfile.reasoningEffort, null);
  assert.equal(binding.policyProfile.collaborationMode, null);
  assert.equal(binding.policyProfile.skillsContext, null);
});

test("appendAudit writes through buffered async flush", async () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.appendAudit({ type: "daemon_started", pid: 123 });
  store.appendAudit({ type: "daemon_stopped", pid: 123 });
  await store.flush();

  const audit = store.readAudit(10);
  assert.equal(audit.length >= 2, true);
  assert.equal(audit[audit.length - 2].type, "daemon_started");
  assert.equal(audit[audit.length - 1].type, "daemon_stopped");
});

test("readAudit includes buffered entries before flush", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.appendAudit({ type: "event_one" });
  store.appendAudit({ type: "event_two" });

  const audit = store.readAudit(10);
  assert.equal(audit.length >= 2, true);
  assert.equal(audit[audit.length - 2].type, "event_one");
  assert.equal(audit[audit.length - 1].type, "event_two");
});

test("readAudit de-duplicates records with the same auditId", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.appendAudit({ type: "dedupe_event" });
  const line = String(store.auditBuffer[0] || "");
  fs.appendFileSync(store.auditPath, `${line}\n`, { encoding: "utf8" });
  store.auditInFlight.push([line]);

  const audit = store.readAudit(10).filter((entry) => entry.type === "dedupe_event");
  assert.equal(audit.length, 1);
});

test("appendAudit requeues failed async writes and retries later", async () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });
  const originalAuditPath = store.auditPath;

  store.auditPath = store.dataDir;
  store.appendAudit({ type: "retry_event" });
  await new Promise((resolve) => setTimeout(resolve, 350));

  store.auditPath = originalAuditPath;
  await new Promise((resolve) => setTimeout(resolve, 400));
  await store.flush();

  const audit = store.readAudit(20).filter((entry) => entry.type === "retry_event");
  assert.equal(audit.length, 1);
});

test("markDeliveryOnce persists dedupe keys across store reload", () => {
  const dir = tempDir();
  const store1 = new StateStore({ baseDir: dir });
  assert.equal(store1.markDeliveryOnce("delivery:key:1"), true);
  assert.equal(store1.markDeliveryOnce("delivery:key:1"), false);

  const store2 = new StateStore({ baseDir: dir });
  assert.equal(store2.markDeliveryOnce("delivery:key:1"), false);
  assert.equal(store2.markDeliveryOnce("delivery:key:2"), true);
});
