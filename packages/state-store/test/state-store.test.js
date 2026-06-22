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
      autopilot: {
        enabled: true,
        mode: "conservative",
        continueOnTurnComplete: true,
        maxAutomaticTurns: 7,
        maxConsecutivePauses: 3,
        commandAllowPrefixes: ["npm test"],
        allowedWriteRoots: ["/tmp"],
        toolInputStrategy: "recommended_only",
      },
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
  assert.equal(binding.policyProfile.autopilot.enabled, true);
  assert.equal(binding.policyProfile.autopilot.continueOnTurnComplete, true);
  assert.equal(binding.policyProfile.autopilot.commandAllowPrefixes[0], "npm test");
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
  assert.equal(config.defaults.output.resumeHistoryTurns, 3);
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

test("bindings normalize autopilot defaults with safe command prefixes", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "defaults",
    policyProfile: {},
  });

  const binding = store.getBinding("discord", "defaults");
  assert.equal(binding.policyProfile.autopilot.enabled, false);
  assert.equal(binding.policyProfile.autopilot.mode, "conservative");
  assert.equal(binding.policyProfile.autopilot.commandAllowPrefixes.includes("npm test"), true);
  assert.equal(binding.policyProfile.autopilot.commandAllowPrefixes.includes("git status"), true);
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
      autopilot: {
        enabled: true,
        mode: "conservative",
        continueOnTurnComplete: false,
      },
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
  assert.equal(binding.policyProfile.autopilot.enabled, true);
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

test("upsert binding supports explicit clearing of threadId", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "thread-clear",
    threadId: "thread-1",
  });

  store.upsertBinding({
    channel: "discord",
    chatId: "thread-clear",
    threadId: null,
  });

  const binding = store.getBinding("discord", "thread-clear");
  assert.equal(binding.threadId, null);
});

test("autopilot sessions persist across writes", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertAutopilotSession({
    bindingKey: "discord:123",
    threadId: "thread-1",
    activeTurnId: "turn-1",
    status: "running_turn",
    automaticTurns: 2,
    consecutivePauses: 1,
    lastAction: { type: "continue" },
  });

  const store2 = new StateStore({ baseDir: dir });
  const session = store2.getAutopilotSession("discord:123");
  assert.equal(session.threadId, "thread-1");
  assert.equal(session.activeTurnId, "turn-1");
  assert.equal(session.automaticTurns, 2);
  assert.equal(session.lastAction.type, "continue");
});

test("appendAudit writes synchronously and is immediately readable", async () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.appendAudit({ type: "daemon_started", pid: 123 });
  store.appendAudit({ type: "daemon_stopped", pid: 123 });

  // No flush needed: appends land on disk synchronously.
  const audit = store.readAudit(10);
  assert.equal(audit.length >= 2, true);
  assert.equal(audit[audit.length - 2].type, "daemon_started");
  assert.equal(audit[audit.length - 1].type, "daemon_stopped");

  // flush() remains a callable no-op (daemon-app.js awaits it).
  await store.flush();
});

test("appendAudit survives a process restart by reading the file", () => {
  const dir = tempDir();
  const store1 = new StateStore({ baseDir: dir });
  store1.appendAudit({ type: "event_one" });
  store1.appendAudit({ type: "event_two" });

  const store2 = new StateStore({ baseDir: dir });
  const audit = store2.readAudit(10);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].type, "event_one");
  assert.equal(audit[1].type, "event_two");
});

test("appendAudit rotates audit.jsonl by size and keeps generations", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  // Prime an oversized current log so the next append triggers rotation.
  fs.writeFileSync(store.auditPath, `${"x".repeat(60 * 1024 * 1024)}\n`, { encoding: "utf8" });
  store.appendAudit({ type: "after_rotate" });

  assert.equal(fs.existsSync(`${store.auditPath}.1`), true);
  // The fresh log holds only the post-rotation event.
  const audit = store.readAudit(10);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].type, "after_rotate");

  // Rotate a second time: .1 shifts to .2, current becomes .1.
  fs.appendFileSync(store.auditPath, `${"y".repeat(60 * 1024 * 1024)}\n`, { encoding: "utf8" });
  store.appendAudit({ type: "after_rotate_again" });
  assert.equal(fs.existsSync(`${store.auditPath}.1`), true);
  assert.equal(fs.existsSync(`${store.auditPath}.2`), true);
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

test("channel cursors persist across store reload", () => {
  const dir = tempDir();
  const store1 = new StateStore({ baseDir: dir });
  assert.equal(store1.setChannelCursor("discord", "chat-1", "10"), "10");

  const store2 = new StateStore({ baseDir: dir });
  assert.equal(store2.getChannelCursor("discord", "chat-1"), "10");
  assert.equal(store2.setChannelCursor("discord", "chat-1", "11"), "11");

  const store3 = new StateStore({ baseDir: dir });
  assert.equal(store3.getChannelCursor("discord", "chat-1"), "11");
});

test("readConfig normalizes for use without writing the file back", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  // No config file on disk yet.
  assert.equal(fs.existsSync(store.configPath), false);
  const config = store.readConfig();
  assert.equal(config.defaults.approvalMode, "on-request");

  // H5-config: reading must not create or rewrite the operator-owned file.
  assert.equal(fs.existsSync(store.configPath), false);
});

test("readConfig does not clobber an operator-edited config with extra keys", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  // Write a config that carries an operator key the normalizer does not model.
  store.writeConfig({ defaults: { approvalMode: "never" }, operatorNote: "do-not-touch" });
  const before = fs.readFileSync(store.configPath, "utf8");

  store.readConfig();

  // The read had no side effects: the file is byte-identical.
  assert.equal(fs.readFileSync(store.configPath, "utf8"), before);
});

test("getBindings normalizes for use without writing the file back", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  // Seed a raw binding with a legacy field that normalization strips.
  fs.writeFileSync(
    store.bindingsPath,
    JSON.stringify({ "discord:x": { channel: "discord", chatId: "x", policyProfile: { desktopSyncEnabled: true } } }),
    "utf8"
  );
  const before = fs.readFileSync(store.bindingsPath, "utf8");

  const bindings = store.getBindings();
  assert.equal(Object.prototype.hasOwnProperty.call(bindings["discord:x"].policyProfile, "desktopSyncEnabled"), false);

  // H5-config: the getter must not rewrite disk.
  assert.equal(fs.readFileSync(store.bindingsPath, "utf8"), before);
});

test("getAutopilotSessions normalizes for use without writing the file back", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  fs.writeFileSync(
    store.autopilotSessionsPath,
    JSON.stringify({ "discord:1": { status: "running_turn", automaticTurns: 2 } }),
    "utf8"
  );
  const before = fs.readFileSync(store.autopilotSessionsPath, "utf8");

  const sessions = store.getAutopilotSessions();
  assert.equal(sessions["discord:1"].status, "running_turn");
  assert.equal(fs.readFileSync(store.autopilotSessionsPath, "utf8"), before);
});

test("migrate rewrites on-disk files into normalized shape exactly once", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  fs.writeFileSync(
    store.bindingsPath,
    JSON.stringify({ "discord:m": { channel: "discord", chatId: "m", policyProfile: { desktopSyncEnabled: true } } }),
    "utf8"
  );

  store.migrate();

  // After an explicit migrate, the legacy field is gone on disk.
  const onDisk = JSON.parse(fs.readFileSync(store.bindingsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk["discord:m"].policyProfile, "desktopSyncEnabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk["discord:m"].policyProfile, "autopilot"), true);

  // Running migrate again on already-normalized data is a no-op (idempotent).
  const before = fs.readFileSync(store.bindingsPath, "utf8");
  store.migrate();
  assert.equal(fs.readFileSync(store.bindingsPath, "utf8"), before);
});

test("binding normalization preserves a string workspaceRoot", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "ws",
    workspaceRoot: "/srv/project",
  });

  const binding = store.getBinding("discord", "ws");
  assert.equal(binding.workspaceRoot, "/srv/project");

  // Survives a reload (read path preserves it too).
  const store2 = new StateStore({ baseDir: dir });
  assert.equal(store2.getBinding("discord", "ws").workspaceRoot, "/srv/project");

  // Partial update without workspaceRoot keeps the existing value.
  store2.upsertBinding({ channel: "discord", chatId: "ws", policyProfile: { approvalMode: "never" } });
  assert.equal(store2.getBinding("discord", "ws").workspaceRoot, "/srv/project");
});

test("binding normalization drops a non-string or empty workspaceRoot", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  fs.writeFileSync(
    store.bindingsPath,
    JSON.stringify({
      "discord:a": { channel: "discord", chatId: "a", workspaceRoot: 123 },
      "discord:b": { channel: "discord", chatId: "b", workspaceRoot: "   " },
    }),
    "utf8"
  );

  const bindings = store.getBindings();
  assert.equal(Object.prototype.hasOwnProperty.call(bindings["discord:a"], "workspaceRoot"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bindings["discord:b"], "workspaceRoot"), false);
});

test("config normalization accepts optional defaults.workspaceRoot", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.writeConfig({ defaults: { workspaceRoot: "/srv/root" } });
  const config = store.readConfig();
  assert.equal(config.defaults.workspaceRoot, "/srv/root");

  // Absent when not provided.
  const dir2 = tempDir();
  const store2 = new StateStore({ baseDir: dir2 });
  assert.equal(Object.prototype.hasOwnProperty.call(store2.readConfig().defaults, "workspaceRoot"), false);
});

test("thread plan-mode normalization persists across reload", () => {
  const dir = tempDir();
  const store = new StateStore({ baseDir: dir });

  store.upsertBinding({
    channel: "discord",
    chatId: "plan",
    policyProfile: {
      threadPlanModeByThreadId: { "thread-plan": true, "thread-off": false },
    },
  });

  const store2 = new StateStore({ baseDir: dir });
  const binding = store2.getBinding("discord", "plan");
  assert.equal(binding.policyProfile.threadPlanModeByThreadId["thread-plan"], true);
  // Falsey entries are dropped by normalization.
  assert.equal(Object.prototype.hasOwnProperty.call(binding.policyProfile.threadPlanModeByThreadId, "thread-off"), false);
});
