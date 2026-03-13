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

test("server request approval roundtrip", async () => {
  const runtime = buildRuntime();
  await runtime.initialize();

  const started = await runtime.startThread({ cwd: process.cwd() });
  const seen = { request: null, completed: false };

  runtime.on("serverRequest", async (request) => {
    seen.request = request;
    await runtime.respondServerRequest(request.id, { decision: "accept" });
  });

  runtime.on("notification", (notification) => {
    if (notification.method === "turn/completed") {
      seen.completed = true;
    }
  });

  await runtime.startTurn({
    threadId: started.thread.id,
    input: [{ type: "text", text: "needs approval" }],
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(seen.request?.method, "item/commandExecution/requestApproval");
  assert.equal(seen.completed, true);

  await runtime.stop();
});
