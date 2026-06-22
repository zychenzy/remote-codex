import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../../state-store/src/index.js";
import { ApprovalBroker } from "../src/approval-broker.js";
import { AutopilotSupervisor } from "../src/autopilot-supervisor.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-autopilot-"));
}

function binding() {
  return {
    channel: "discord",
    chatId: "chat-1",
    threadId: "thread-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      autopilot: {
        enabled: true,
        mode: "conservative",
        continueOnTurnComplete: true,
        maxAutomaticTurns: 5,
        maxConsecutivePauses: 2,
        commandAllowPrefixes: ["npm test"],
        allowedWriteRoots: ["/Users/czy/auto"],
        toolInputStrategy: "recommended_only",
      },
    },
  };
}

test("autopilot supervisor resolves safe approval requests through the broker", async () => {
  const store = new StateStore({ baseDir: tempDir() });
  const approvalBroker = new ApprovalBroker({ timeoutMs: 1000 });
  const supervisor = new AutopilotSupervisor({
    store,
    approvalBroker,
  });
  const decisions = [];
  approvalBroker.on("resolved", (resolution) => decisions.push(resolution));

  const serverRequest = {
    id: "srv-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      command: "npm test",
      cwd: "/Users/czy/auto",
    },
  };
  const created = approvalBroker.create({
    serverRequest,
    binding: binding(),
    autoApprove: false,
  });

  const result = await supervisor.onServerRequest(serverRequest, binding(), created.record);
  assert.equal(result.handled, true);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "allow");
  assert.equal(decisions[0].actor, "autopilot");
});

test("autopilot supervisor starts a follow-up turn for clear continuation", async () => {
  const store = new StateStore({ baseDir: tempDir() });
  const approvalBroker = new ApprovalBroker({ timeoutMs: 1000 });
  const followups = [];
  const supervisor = new AutopilotSupervisor({
    store,
    approvalBroker,
    startFollowupTurn: async (_binding, prompt) => {
      followups.push(prompt);
      return { threadId: "thread-1", turnId: "turn-2" };
    },
  });

  const result = await supervisor.onTurnCompleted({
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistant: "Updated the failing tests.",
    pendingApprovalsCount: 0,
    turnItems: [
      { type: "commandExecution" },
      { type: "fileChange" },
      { type: "agentMessage" },
    ],
    hasTurnDiff: true,
  }, binding());

  assert.equal(result.handled, true);
  assert.equal(followups.length, 1);
  assert.equal(String(followups[0]).includes("Continue with the next concrete step"), true);
  assert.equal(store.getAutopilotSession("discord:chat-1")?.automaticTurns, 1);
});

test("autopilot supervisor resolves as system actor with overrideOwnership", async () => {
  const store = new StateStore({ baseDir: tempDir() });
  const calls = [];
  const approvalBroker = {
    resolve(localRequestId, opts) {
      calls.push({ localRequestId, opts });
      return { localRequestId, decision: opts.decision, actor: opts.actor, record: {} };
    },
  };
  const supervisor = new AutopilotSupervisor({ store, approvalBroker });

  const serverRequest = {
    id: "srv-1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", command: "npm test", cwd: "/Users/czy/auto" },
  };
  const result = await supervisor.onServerRequest(serverRequest, binding(), { localRequestId: "local-1" });

  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.actor, "autopilot");
  assert.equal(calls[0].opts.overrideOwnership, true);
});

test("autopilot supervisor keeps handled true when post-resolve session write fails", async () => {
  const warnings = [];
  const approvalBroker = {
    resolve(localRequestId, opts) {
      return { localRequestId, decision: opts.decision, actor: opts.actor, record: {} };
    },
  };
  const store = {
    getAutopilotSession() {
      return null;
    },
    upsertAutopilotSession() {
      throw new Error("disk full");
    },
  };
  const supervisor = new AutopilotSupervisor({
    store,
    approvalBroker,
    logger: { warn: (message) => warnings.push(message) },
  });

  const serverRequest = {
    id: "srv-1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", command: "npm test", cwd: "/Users/czy/auto" },
  };
  const result = await supervisor.onServerRequest(serverRequest, binding(), { localRequestId: "local-1" });

  assert.equal(result.handled, true);
  assert.equal(warnings.some((message) => message.includes("session write failed")), true);
});

test("autopilot supervisor increments automaticTurns from session re-read after the await", async () => {
  const store = new StateStore({ baseDir: tempDir() });
  const approvalBroker = new ApprovalBroker({ timeoutMs: 1000 });
  const supervisor = new AutopilotSupervisor({
    store,
    approvalBroker,
    // Simulate a concurrent mutation landing during the follow-up await: the fresh
    // snapshot has automaticTurns=4, so the increment must produce 5 (not stale 0 + 1).
    startFollowupTurn: async () => {
      store.upsertAutopilotSession({ bindingKey: "discord:chat-1", automaticTurns: 4 });
      return { threadId: "thread-1", turnId: "turn-2" };
    },
  });

  const result = await supervisor.onTurnCompleted({
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistant: "Updated the failing tests.",
    pendingApprovalsCount: 0,
    turnItems: [
      { type: "commandExecution" },
      { type: "fileChange" },
      { type: "agentMessage" },
    ],
    hasTurnDiff: true,
  }, binding());

  assert.equal(result.handled, true);
  assert.equal(store.getAutopilotSession("discord:chat-1")?.automaticTurns, 5);
});
