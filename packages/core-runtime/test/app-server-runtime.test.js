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
