import test from "node:test";
import assert from "node:assert/strict";

import { toBoolean, resolveBindTargets } from "../src/utils.js";

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
