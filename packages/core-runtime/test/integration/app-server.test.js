import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { AppServerRuntime } from "../../src/index.js";

// A real Codex subprocess, with only inference replaced by a loopback SSE
// fixture. No Discord, login, external network, model billing, or user config.
test("current app-server: handshake, goals, modes, streaming, persistence and resume", { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reco-app-server-"));
  const home = path.join(root, "codex");
  const cwd = path.join(root, "workspace");
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  let runtime;
  let server;
  t.after(async () => {
    await runtime?.stop();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const requests = [];
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const toolCall = requests.length === 3;
    const item = toolCall
      ? { id: "fc_smoke", type: "function_call", call_id: "call_smoke", name: "smoke_probe", arguments: "{}", status: "completed" }
      : { id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "LOCAL_SMOKE_OK", annotations: [] }] };
    send({ type: "response.created", response: { id: "resp_smoke", status: "in_progress", output: [] } });
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    if (!toolCall) send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "LOCAL_SMOKE_OK" });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response: { id: "resp_smoke", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await fs.writeFile(path.join(home, "config.toml"), `
model = "gpt-5.4"
model_provider = "local_smoke"
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.local_smoke]
name = "Local smoke fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
  runtime = new AppServerRuntime({
    launchSpec: {
      command: process.execPath,
      args: [path.resolve("node_modules/@openai/codex/bin/codex.js"), "app-server", "--listen", "stdio://"],
      options: { cwd },
    },
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: os.tmpdir() },
    reconnect: false,
    requestTimeoutMs: 10_000,
  });
  const notifications = [];
  runtime.on("notification", (event) => notifications.push(event));
  await Promise.all([runtime.initialize(), runtime.initialize()]);
  const models = await runtime.listModels();
  assert.ok(Array.isArray(models.data));
  const serverRequests = [];
  runtime.on("serverRequest", async (request) => {
    serverRequests.push(request);
    await runtime.respondServerRequest(request.id, { success: false, contentItems: [{ type: "inputText", text: "Probe declined by test operator" }] });
  });
  const started = await runtime.startThread({ cwd, sandbox: "read-only", dynamicTools: [{ type: "function", name: "smoke_probe", description: "Local protocol probe", inputSchema: { type: "object", properties: {} } }] });
  const threadId = started.thread.id;
  assert.equal(started.model, "gpt-5.4");
  const goal = await runtime.setThreadGoal({ threadId, goal: "Verify local protocol compatibility" });
  assert.equal(goal.goal.objective, "Verify local protocol compatibility");
  assert.equal((await runtime.getThreadGoal(threadId)).goal.status, "active");
  await runtime.clearThreadGoal(threadId);
  assert.equal((await runtime.getThreadGoal(threadId)).goal, null);

  for (const serviceTier of ["priority", null, null]) {
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("turn/completed not received")); }, 15_000);
      const off = runtime.on("notification", (event) => {
        if (event.method !== "turn/completed" || event.params.threadId !== threadId) return;
        clearTimeout(timer);
        off();
        resolve(event.params.turn);
      });
    });
    // Observe rejection even if turn/start itself fails before awaiting it.
    completed.catch(() => {});
    await runtime.startTurn({ threadId, input: "Reply with LOCAL_SMOKE_OK", collaborationMode: serviceTier ? "plan" : "default", serviceTier });
    const turn = await completed;
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
    const settings = await runtime.resumeThread(threadId);
    assert.equal(settings.serviceTier, serviceTier ?? "default");
  }
  assert.ok(notifications.some((event) => event.method === "item/agentMessage/delta" && event.params.delta === "LOCAL_SMOKE_OK"));
  assert.equal(requests.length, 4);
  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].method, "item/tool/call");
  assert.equal(serverRequests[0].params.tool, "smoke_probe");
  // Custom providers may omit service_tier from inference requests; protocol
  // acceptance and explicit clearing are checked at the app-server boundary.
  assert.ok((await runtime.readThread({ threadId, includeTurns: true })).thread.turns.length >= 2);
  assert.ok((await runtime.listThreads({ cwd, modelProviders: ["local_smoke"] })).data.some((thread) => thread.id === threadId));
  await runtime.stop();
  const resumed = await runtime.resumeThread(threadId);
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.model, "gpt-5.4");
});
