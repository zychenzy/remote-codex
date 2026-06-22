import test from "node:test";
import assert from "node:assert/strict";

import { toBoolean, resolveBindTargets, getArgValue } from "../src/utils.js";

test("toBoolean accepts y/n and yes/no", () => {
  assert.equal(toBoolean("y", false), true);
  assert.equal(toBoolean("yes", false), true);
  assert.equal(toBoolean("n", true), false);
  assert.equal(toBoolean("no", true), false);
});

test("toBoolean falls back for unknown values", () => {
  assert.equal(toBoolean("maybe", true), true);
  assert.equal(toBoolean("maybe", false), false);
});

test("getArgValue returns the value following a flag", () => {
  const args = ["bind", "discord", "--chat", "12345", "--cwd", "/repo"];
  assert.equal(getArgValue(args, "--chat", null), "12345");
  assert.equal(getArgValue(args, "--cwd", "/default"), "/repo");
});

test("getArgValue does not consume the next flag as a value", () => {
  // --auto-approve is a present-but-valueless flag followed by another flag.
  const args = ["--auto-approve", "--model", "gpt-5.4"];
  assert.equal(getArgValue(args, "--auto-approve", "fallback"), "fallback");
  assert.equal(getArgValue(args, "--model", null), "gpt-5.4");
});

test("getArgValue returns fallback for a trailing flag with no value", () => {
  const args = ["bind", "discord", "--user"];
  assert.equal(getArgValue(args, "--user", null), null);
  assert.equal(getArgValue(args, "--missing", "fb"), "fb");
});

test("resolveBindTargets infers discord ids from config", () => {
  const resolved = resolveBindTargets({
    channel: "discord",
    chatIdArg: null,
    userIdArg: null,
    config: {
      channels: {
        discord: {
          allowedChannels: ["1234567890"],
          allowlist: ["998877"],
        },
      },
    },
  });

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.chatId, "1234567890");
  assert.equal(resolved.userId, "998877");
});

test("resolveBindTargets requires explicit chat when multiple discord channels exist", () => {
  const resolved = resolveBindTargets({
    channel: "discord",
    chatIdArg: null,
    userIdArg: null,
    config: {
      channels: {
        discord: {
          allowedChannels: ["111", "222"],
          allowlist: ["u1"],
        },
      },
    },
  });

  assert.equal(Boolean(resolved.error), true);
});
