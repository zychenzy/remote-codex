import test from "node:test";
import assert from "node:assert/strict";

import { startTurnWithRecovery } from "../src/turn-recovery.js";

const isThreadNotFoundError = (error) => String(error?.message || "").includes("thread not found");

test("turn recovery returns directly when startTurn succeeds", async () => {
  const result = await startTurnWithRecovery({
    threadId: "thread-1",
    baseParams: { input: [{ type: "text", text: "hi" }] },
    startTurn: async ({ threadId }) => ({ turn: { id: `turn-for-${threadId}` } }),
    resumeThread: async () => ({ thread: { id: "thread-1" } }),
    startFreshThread: async () => "thread-fresh",
    isThreadNotFoundError,
  });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnResponse.turn.id, "turn-for-thread-1");
});

test("turn recovery retries successfully after resume", async () => {
  let attempts = 0;
  let recoveredCalled = 0;

  const result = await startTurnWithRecovery({
    threadId: "thread-1",
    baseParams: { input: [{ type: "text", text: "hi" }] },
    startTurn: async ({ threadId }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("thread not found: thread-1");
      }
      return { turn: { id: `turn-for-${threadId}` } };
    },
    resumeThread: async () => ({ thread: { id: "thread-1", cwd: "/repo" } }),
    startFreshThread: async () => "thread-fresh",
    isThreadNotFoundError,
    onRecovered: async () => {
      recoveredCalled += 1;
    },
  });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnResponse.turn.id, "turn-for-thread-1");
  assert.equal(recoveredCalled, 1);
});

test("turn recovery falls back to fresh thread when resumed thread is still missing", async () => {
  let attempts = 0;
  let retryMissingCalled = 0;
  let expiredCalled = 0;
  let recoveredCalled = 0;

  const result = await startTurnWithRecovery({
    threadId: "thread-1",
    baseParams: { input: [{ type: "text", text: "hi" }] },
    startTurn: async ({ threadId }) => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error(`thread not found: ${threadId}`);
      }
      return { turn: { id: `turn-for-${threadId}` } };
    },
    resumeThread: async () => ({ thread: { id: "thread-1" } }),
    startFreshThread: async () => "thread-fresh",
    isThreadNotFoundError,
    onRecovered: async () => {
      recoveredCalled += 1;
    },
    onRecoveredRetryMissing: async () => {
      retryMissingCalled += 1;
    },
    onExpired: async () => {
      expiredCalled += 1;
    },
  });

  assert.equal(result.threadId, "thread-fresh");
  assert.equal(result.turnResponse.turn.id, "turn-for-thread-fresh");
  assert.equal(retryMissingCalled, 1);
  assert.equal(expiredCalled, 1);
  // Resume succeeded but the retry startTurn 404'd: the recovered threadId must
  // NOT be persisted, so onRecovered is never invoked.
  assert.equal(recoveredCalled, 0);
});
