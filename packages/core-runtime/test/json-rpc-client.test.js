import test from "node:test";
import assert from "node:assert/strict";

import { JsonRpcClient } from "../src/index.js";

test("JsonRpcClient correlates requests and responses", async () => {
  const sent = [];
  const client = new JsonRpcClient({ send: (line) => sent.push(JSON.parse(line)), timeoutMs: 1000 });

  const promise = client.request("demo/ping", { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "demo/ping");

  client.handleMessage(JSON.stringify({ id: sent[0].id, result: { pong: true } }));
  const result = await promise;
  assert.deepEqual(result, { pong: true });
});

test("JsonRpcClient emits serverRequest for request-shaped inbound messages", async () => {
  const client = new JsonRpcClient({ send: () => {}, timeoutMs: 1000 });

  let seen = null;
  client.on("serverRequest", (msg) => {
    seen = msg;
  });

  client.handleMessage(JSON.stringify({ id: "abc", method: "item/commandExecution/requestApproval", params: {} }));
  assert.equal(seen?.id, "abc");
});
