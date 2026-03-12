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

test("parser handles cwd command", () => {
  const result = parseIncomingCommand("/cwd ~/projects/demo");
  assert.equal(result.type, "cwd");
  assert.equal(result.path, "~/projects/demo");
});
