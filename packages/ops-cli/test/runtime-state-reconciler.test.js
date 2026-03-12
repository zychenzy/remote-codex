import test from "node:test";
import assert from "node:assert/strict";

import { reconcileRuntimeState } from "../src/runtime-state-reconciler.js";

function makeLogger() {
  return {
    warn: () => {},
    info: () => {},
  };
}

test("reconcileRuntimeState clears stale bindings and resets turn maps", async () => {
  const bindings = [
    {
      channel: "discord",
      chatId: "1",
      threadId: "thread-stale",
      workingDir: "/repo-a",
      policyProfile: {},
    },
    {
      channel: "discord",
      chatId: "2",
      threadId: "thread-loaded",
      workingDir: "/repo-b",
      policyProfile: {},
    },
  ];
  const upserts = [];
  const store = {
    listBindings: () => bindings,
    upsertBinding: (binding) => {
      upserts.push(binding);
      return binding;
    },
  };

  const runtime = {
    listLoadedThreads: async () => ({ data: ["thread-loaded"] }),
    readThread: async ({ threadId }) => {
      if (threadId === "thread-stale") {
        throw new Error("thread not found: thread-stale");
      }
      return { thread: { cwd: "/repo-b" } };
    },
  };

  const threadToBinding = new Map([["old-thread", "discord:9"]]);
  const turnToBinding = new Map([["turn-1", "discord:9"]]);
  const activeTurnByBinding = new Map([["discord:9", "turn-1"]]);

  const result = await reconcileRuntimeState({
    store,
    runtime,
    logger: makeLogger(),
    threadToBinding,
    turnToBinding,
    activeTurnByBinding,
    bindingKeyFn: (channel, chatId) => `${channel}:${chatId}`,
    isThreadNotFoundError: (error) => String(error?.message || "").includes("thread not found"),
    extractThreadCwd: (thread) => String(thread?.cwd || ""),
  });

  assert.equal(result.loadedCount, 1);
  assert.equal(result.clearedBindings, 1);
  assert.equal(turnToBinding.size, 0);
  assert.equal(activeTurnByBinding.size, 0);
  assert.equal(threadToBinding.has("thread-loaded"), true);
  assert.equal(threadToBinding.has("thread-stale"), false);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].threadId, null);
});

test("reconcileRuntimeState refreshes binding cwd from runtime thread metadata", async () => {
  const binding = {
    channel: "telegram",
    chatId: "77",
    threadId: "thread-1",
    workingDir: "/old-cwd",
    policyProfile: {},
  };
  const upserts = [];
  const store = {
    listBindings: () => [binding],
    upsertBinding: (next) => {
      upserts.push(next);
      return next;
    },
  };

  const runtime = {
    listLoadedThreads: async () => ({ data: [] }),
    readThread: async () => ({ thread: { cwd: "/new-cwd" } }),
  };

  const result = await reconcileRuntimeState({
    store,
    runtime,
    logger: makeLogger(),
    threadToBinding: new Map(),
    turnToBinding: new Map(),
    activeTurnByBinding: new Map(),
    bindingKeyFn: (channel, chatId) => `${channel}:${chatId}`,
    isThreadNotFoundError: () => false,
    extractThreadCwd: (thread) => String(thread?.cwd || ""),
  });

  assert.equal(result.verifiedThreads, 1);
  assert.equal(result.refreshedCwd, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].workingDir, "/new-cwd");
});

