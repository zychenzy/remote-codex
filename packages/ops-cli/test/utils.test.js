import test from "node:test";
import assert from "node:assert/strict";

import { toBoolean } from "../src/utils.js";

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
