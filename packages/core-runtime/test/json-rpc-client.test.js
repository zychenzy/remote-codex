import test from "node:test";
import assert from "node:assert/strict";

import { JsonRpcClient, EventBus } from "../src/index.js";

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

test("JsonRpcClient namespaces client ids so server ids cannot collide", async () => {
  // M-idcollision: client request ids are namespaced ("c-N"). A server-assigned
  // integer id of 1 must not be mistaken for the first pending client request.
  const sent = [];
  const client = new JsonRpcClient({ send: (line) => sent.push(JSON.parse(line)), timeoutMs: 1000 });

  const promise = client.request("demo/ping", {});
  assert.equal(sent[0].id, "c-1");

  let orphan = null;
  client.on("orphanResponse", (msg) => {
    orphan = msg;
  });

  // A response shaped with bare integer id 1 (as a server might assign) is an
  // orphan, not a resolution of the pending "c-1" client request.
  client.handleMessage(JSON.stringify({ id: 1, result: { collided: true } }));
  assert.equal(orphan?.id, 1);

  // The real namespaced response still resolves the client request.
  client.handleMessage(JSON.stringify({ id: "c-1", result: { pong: true } }));
  assert.deepEqual(await promise, { pong: true });
});

test("EventBus isolates throwing listeners and keeps emitting", () => {
  // A throwing handler must not abort the loop or propagate into the emitter.
  const seen = [];
  const errors = [];
  const bus = new EventBus({ logger: { error: (...args) => errors.push(args) } });

  bus.on("tick", () => {
    throw new Error("boom");
  });
  bus.on("tick", (payload) => seen.push(payload));

  assert.doesNotThrow(() => bus.emit("tick", 42));
  assert.deepEqual(seen, [42]);
  assert.equal(errors.length, 1);
});
