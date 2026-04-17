import test from "node:test";
import assert from "node:assert/strict";

import { commandManual } from "../src/help-manual.js";

test("commandManual returns general manual", () => {
  const text = commandManual("");
  assert.equal(text.includes("IM command manual"), true);
  assert.equal(text.includes("/thread ..."), true);
  assert.equal(text.includes("/files - browse"), true);
  assert.equal(text.includes("/search <pattern>"), true);
  assert.equal(text.includes("/skills ..."), true);
  assert.equal(text.includes("/approve auto <on|off|show>"), true);
  assert.equal(text.includes("/plan <on|off|show>"), true);
  assert.equal(text.includes("/answer [requestId]"), true);
  assert.equal(text.includes("Daemon auth context follows current Codex login"), true);
});

test("commandManual normalizes topic with slash prefix", () => {
  const text = commandManual("/help");
  assert.equal(text.includes("/help [command]"), true);
});

test("commandManual returns unknown topic guidance", () => {
  const text = commandManual("nonexistent-command");
  assert.equal(text.includes("Unknown help topic"), true);
  assert.equal(text.includes("Try /help"), true);
});
