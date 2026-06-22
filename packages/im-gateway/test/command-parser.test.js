import test from "node:test";
import assert from "node:assert/strict";

import { parseIncomingCommand } from "../src/index.js";

test("parser handles ask command", () => {
  const result = parseIncomingCommand("/ask hello world");
  assert.equal(result.type, "ask");
  assert.equal(result.prompt, "hello world");
});

test("parser treats plain text as ask", () => {
  const result = parseIncomingCommand("fix this bug");
  assert.equal(result.type, "ask");
  assert.equal(result.prompt, "fix this bug");
});

test("parser handles approve command", () => {
  const result = parseIncomingCommand("/approve req-1 allow foo=bar");
  assert.equal(result.type, "approve");
  assert.equal(result.requestId, "req-1");
  assert.equal(result.decision, "allow");
});

test("parser handles approve auto command", () => {
  const result = parseIncomingCommand("/approve auto on");
  assert.equal(result.type, "approveAuto");
  assert.equal(result.action, "on");
  assert.equal(result.threadId, "");
});

test("parser handles approve auto command with explicit thread id", () => {
  const result = parseIncomingCommand("/approve auto off thread-1");
  assert.equal(result.type, "approveAuto");
  assert.equal(result.action, "off");
  assert.equal(result.threadId, "thread-1");
});

test("parser handles plan command", () => {
  const result = parseIncomingCommand("/plan on");
  assert.equal(result.type, "plan");
  assert.equal(result.action, "on");
});

test("parser handles fast command", () => {
  const result = parseIncomingCommand("/fast off");
  assert.equal(result.type, "fast");
  assert.equal(result.action, "off");
});

test("parser handles goal command", () => {
  const result = parseIncomingCommand("/goal Ship the daemon");
  assert.equal(result.type, "goal");
  assert.equal(result.action, "set");
  assert.equal(result.value, "Ship the daemon");
});

test("parser handles explicit goal management command", () => {
  const result = parseIncomingCommand("/goal set Ship the daemon");
  assert.equal(result.type, "goal");
  assert.equal(result.action, "set");
  assert.equal(result.value, "Ship the daemon");
});

test("parser handles usage command", () => {
  assert.equal(parseIncomingCommand("/usage").type, "usage");
});

test("parser handles requirements command", () => {
  assert.equal(parseIncomingCommand("/requirements").type, "requirements");
});

test("parser handles answer command with explicit request id", () => {
  const result = parseIncomingCommand("/answer 917222ab-9d14-41fa-9afd-d692702d8824 q1=on;q2=off");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "allow");
  assert.equal(result.requestId, "917222ab-9d14-41fa-9afd-d692702d8824");
  assert.equal(result.payload, "q1=on;q2=off");
});

test("parser handles answer command without request id", () => {
  const result = parseIncomingCommand("/answer q1=on;q2=off");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "allow");
  assert.equal(result.requestId, "");
  assert.equal(result.payload, "q1=on;q2=off");
});

test("parser handles answer deny shorthand", () => {
  const result = parseIncomingCommand("/answer deny 917222ab-9d14-41fa-9afd-d692702d8824");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "deny");
  assert.equal(result.requestId, "917222ab-9d14-41fa-9afd-d692702d8824");
});

test("parser handles answer recommended shorthand without request id", () => {
  const result = parseIncomingCommand("/answer rec");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "allow");
  assert.equal(result.requestId, "");
  assert.equal(result.payload, "rec");
});

test("parser handles answer numeric shorthand without request id", () => {
  const result = parseIncomingCommand("/answer 1 2 1");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "allow");
  assert.equal(result.requestId, "");
  assert.equal(result.payload, "1 2 1");
});

test("parser handles cwd command", () => {
  const result = parseIncomingCommand("/cwd ~/projects/demo");
  assert.equal(result.type, "cwd");
  assert.equal(result.command, "cwd");
  assert.equal(result.path, "~/projects/demo");
});

test("parser handles bare cwd command", () => {
  const result = parseIncomingCommand("/cwd");
  assert.equal(result.type, "cwd");
  assert.equal(result.path, "");
});

test("parser handles cwd browse command", () => {
  const result = parseIncomingCommand("/cwd browse ~/auto/packages");
  assert.equal(result.type, "cwd");
  assert.equal(result.path, "browse ~/auto/packages");
});

test("parser handles cwd new command", () => {
  const result = parseIncomingCommand("/cwd new ~/auto/new-project");
  assert.equal(result.type, "cwd");
  assert.equal(result.command, "cwd");
  assert.equal(result.path, "new ~/auto/new-project");
});

test("parser handles workspace new command", () => {
  const result = parseIncomingCommand("/workspace new ~/auto/new-project");
  assert.equal(result.type, "cwd");
  assert.equal(result.command, "workspace");
  assert.equal(result.path, "new ~/auto/new-project");
});

test("parser handles files command", () => {
  const result = parseIncomingCommand("/files");
  assert.equal(result.type, "files");
  assert.deepEqual(result.args, []);
});

test("parser handles search command", () => {
  const result = parseIncomingCommand("/search daemon app");
  assert.equal(result.type, "search");
  assert.equal(result.pattern, "daemon app");
});

test("parser handles help command", () => {
  const result = parseIncomingCommand("/help approve");
  assert.equal(result.type, "help");
  assert.equal(result.topic, "approve");
});

test("parser handles autopilot status command", () => {
  const result = parseIncomingCommand("/autopilot status");
  assert.equal(result.type, "autopilot");
  assert.equal(result.action, "status");
});

test("parser handles autopilot continue command", () => {
  const result = parseIncomingCommand("/autopilot continue on");
  assert.equal(result.type, "autopilot");
  assert.equal(result.action, "continue");
  assert.deepEqual(result.args, ["on"]);
});

test("parser handles autopilot mode command", () => {
  const result = parseIncomingCommand("/autopilot mode aggressive");
  assert.equal(result.type, "autopilot");
  assert.equal(result.action, "mode");
  assert.deepEqual(result.args, ["aggressive"]);
});

test("parser maps stop to interrupt", () => {
  const result = parseIncomingCommand("/stop");
  assert.equal(result.type, "interrupt");
});

test("parser handles threads command", () => {
  const result = parseIncomingCommand("/threads 20");
  assert.equal(result.type, "threads");
  assert.equal(result.limit, 20);
  assert.equal(result.all, false);
});

test("parser handles threads all command", () => {
  const result = parseIncomingCommand("/threads all 30");
  assert.equal(result.type, "threads");
  assert.equal(result.limit, 30);
  assert.equal(result.all, true);
});

test("parser handles threads --all command", () => {
  const result = parseIncomingCommand("/threads --all 15");
  assert.equal(result.type, "threads");
  assert.equal(result.limit, 15);
  assert.equal(result.all, true);
});

test("parser handles model command", () => {
  const result = parseIncomingCommand("/model gpt-5.3-codex");
  assert.equal(result.type, "model");
  assert.equal(result.value, "gpt-5.3-codex");
});

test("parser handles archive command", () => {
  const result = parseIncomingCommand("/archive thread-1");
  assert.equal(result.type, "archive");
  assert.equal(result.threadId, "thread-1");
});

test("parser handles namespaced thread command", () => {
  const result = parseIncomingCommand("/thread list all 20");
  assert.equal(result.type, "thread");
  assert.equal(result.action, "list");
  assert.deepEqual(result.args, ["all", "20"]);
});

test("parser handles thread more command", () => {
  const result = parseIncomingCommand("/thread more 25");
  assert.equal(result.type, "thread");
  assert.equal(result.action, "more");
  assert.deepEqual(result.args, ["25"]);
});

test("parser handles namespaced turn command", () => {
  const result = parseIncomingCommand("/turn steer continue with tests");
  assert.equal(result.type, "turn");
  assert.equal(result.action, "steer");
  assert.deepEqual(result.args, ["continue", "with", "tests"]);
});

test("parser maps legacy /model list to /model picker behavior", () => {
  const result = parseIncomingCommand("/model list");
  assert.equal(result.type, "model");
  assert.equal(result.value, "");
});

test("parser handles namespaced model effort command", () => {
  const result = parseIncomingCommand("/model effort set high");
  assert.equal(result.type, "modelNs");
  assert.equal(result.action, "effort");
  assert.deepEqual(result.args, ["set", "high"]);
});

test("parser handles namespaced skills command", () => {
  const result = parseIncomingCommand("/skills list");
  assert.equal(result.type, "skills");
  assert.equal(result.action, "list");
});

test("parser strips control bytes from slice-based command payloads", () => {
  const result = parseIncomingCommand("/cwd /tmp/a\x00\nb");
  assert.equal(result.type, "cwd");
  assert.equal(result.path, "/tmp/ab");
});

test("parser strips embedded NUL bytes from search pattern", () => {
  const result = parseIncomingCommand("/search foo\x00bar");
  assert.equal(result.type, "search");
  assert.equal(result.pattern, "foobar");
});

test("parser caps total command length", () => {
  const result = parseIncomingCommand(`/ask ${"x".repeat(20000)}`);
  assert.equal(result.type, "ask");
  assert.equal(result.prompt.length <= 8000, true);
});

test("parser rejects non-integer thread limits and falls back to default", () => {
  assert.equal(parseIncomingCommand("/threads 1.5").limit, 10);
  assert.equal(parseIncomingCommand("/threads 1e3").limit, 10);
  assert.equal(parseIncomingCommand("/threads 0x10").limit, 10);
});

test("parser routes a non-UUID answer request id by arity", () => {
  const result = parseIncomingCommand("/answer req-42 q1=on;q2=off");
  assert.equal(result.type, "answer");
  assert.equal(result.decision, "allow");
  assert.equal(result.requestId, "req-42");
  assert.equal(result.payload, "q1=on;q2=off");
});

test("parser keeps numeric-only answer shorthand as payload", () => {
  const result = parseIncomingCommand("/answer 1 2 1");
  assert.equal(result.type, "answer");
  assert.equal(result.requestId, "");
  assert.equal(result.payload, "1 2 1");
});
