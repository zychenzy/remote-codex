import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { AppServerRuntime } from "../src/index.js";

const fixture = path.resolve("./packages/core-runtime/test/fixtures/mock-app-server.js");

function buildRuntime() {
  return new AppServerRuntime({
    launchSpec: {
      command: process.execPath,
      args: [fixture],
      description: "mock-app-server",
      options: {},
    },
    reconnect: false,
    requestTimeoutMs: 3000,
  });
}

test("runtime can initialize, start thread, and list threads", async () => {
  const runtime = buildRuntime();
  await runtime.initialize();

  const started = await runtime.startThread({ cwd: process.cwd() });
  assert.ok(started.thread.id.startsWith("thread-"));

  const list = await runtime.listThreads({ limit: 10 });
  assert.equal(Array.isArray(list.threads), true);
  assert.equal(list.threads.length >= 1, true);

  await runtime.stop();
});

test("runtime emits notification events during turn flow", async () => {
  const runtime = buildRuntime();
  await runtime.initialize();

  const notifications = [];
  runtime.on("notification", (msg) => notifications.push(msg.method));

  const started = await runtime.startThread({ cwd: process.cwd() });
  await runtime.startTurn({ threadId: started.thread.id, input: [{ type: "text", text: "hello" }] });

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(notifications.includes("turn/started"), true);
  assert.equal(notifications.includes("item/agentMessage/delta"), true);
  assert.equal(notifications.includes("turn/completed"), true);

  await runtime.stop();
});

test("runtime encodes string collaborationMode as structured payload", async () => {
  const runtime = buildRuntime();
  await runtime.initialize();

  const started = await runtime.startThread({ cwd: process.cwd() });
  const turn = await runtime.startTurn({
    threadId: started.thread.id,
    input: [{ type: "text", text: "plan this" }],
    model: "gpt-5.4",
    effort: "medium",
    collaborationMode: "plan",
  });

  assert.equal(typeof turn?.turn?.id, "string");
  await runtime.stop();
});

test("runtime exposes extended thread, review, model, and skills wrappers", async () => {
  const runtime = buildRuntime();
  await runtime.initialize();

  const started = await runtime.startThread({ cwd: process.cwd() });
  const threadId = started.thread.id;

  const read = await runtime.readThread({ threadId, includeTurns: false });
  assert.equal(read.thread.id, threadId);

  const forked = await runtime.forkThread({ threadId, ephemeral: false });
  assert.equal(typeof forked.thread.id, "string");

  const loaded = await runtime.listLoadedThreads();
  assert.equal(Array.isArray(loaded.data), true);

  const unsubscribed = await runtime.unsubscribeThread(threadId);
  assert.equal(typeof unsubscribed.status, "string");

  const compacted = await runtime.compactThread(threadId);
  assert.deepEqual(compacted, {});

  const rolledBack = await runtime.rollbackThread({ threadId, numTurns: 1 });
  assert.equal(rolledBack.thread.id, threadId);

  const named = await runtime.setThreadName({ threadId, name: "Release checklist" });
  assert.equal(named.thread.name, "Release checklist");

  const setGoal = await runtime.setThreadGoal({ threadId, goal: "Ship the daemon" });
  assert.equal(setGoal.goal, "Ship the daemon");

  const goal = await runtime.getThreadGoal(threadId);
  assert.equal(goal.goal, "Ship the daemon");

  const clearedGoal = await runtime.clearThreadGoal(threadId);
  assert.deepEqual(clearedGoal, {});

  const turn = await runtime.startTurn({ threadId, input: [{ type: "text", text: "hello again" }] });
  const steer = await runtime.steerTurn({
    threadId,
    expectedTurnId: turn.turn.id,
    input: [{ type: "text", text: "continue" }],
  });
  assert.equal(steer.turnId, turn.turn.id);

  const review = await runtime.startReview({
    threadId,
    delivery: "inline",
    target: { type: "uncommittedChanges" },
  });
  assert.equal(typeof review.turn.id, "string");

  const models = await runtime.listModels({ limit: 10, includeHidden: false });
  assert.equal(Array.isArray(models.data), true);
  assert.equal(models.data.length >= 1, true);

  const modes = await runtime.listCollaborationModes();
  assert.equal(Array.isArray(modes.data), true);
  assert.equal(modes.data.length >= 1, true);

  const skills = await runtime.listSkills({
    cwds: [process.cwd()],
    forceReload: true,
  });
  assert.equal(Array.isArray(skills.data), true);
  assert.equal(skills.data.length >= 1, true);

  const skillWrite = await runtime.writeSkillConfig({
    path: "/tmp/skill-creator/SKILL.md",
    enabled: false,
  });
  assert.equal(skillWrite.ok, true);

  const rateLimits = await runtime.readAccountRateLimits();
  assert.equal(rateLimits.rateLimits.limitId, "codex");

  const requirements = await runtime.readConfigRequirements();
  assert.deepEqual(requirements.requirements.allowedSandboxModes, ["readOnly", "workspaceWrite"]);

  await runtime.archiveThread(threadId);
  const unarchived = await runtime.unarchiveThread(threadId);
  assert.equal(unarchived.thread.id, threadId);

  await runtime.stop();
});
