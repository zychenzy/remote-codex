import test from "node:test";
import assert from "node:assert/strict";

import { TurnOutputService } from "../src/turn-output-service.js";

test("turn output service publishes at code-fence boundary", () => {
  const service = new TurnOutputService();
  const bindingKey = "discord:chat-1";

  const first = service.appendDelta("thread-1", "turn-1", bindingKey, "```js\nconst x = 1;\n");
  assert.equal(first.sectionText, "");

  const second = service.appendDelta("thread-1", "turn-1", bindingKey, "```\n");
  assert.equal(typeof second.sectionText, "string");
  assert.equal(second.sectionText.includes("const x = 1;"), true);
});

test("turn output service soft-publishes long text without blank-line boundary", () => {
  const service = new TurnOutputService({ minChunkChars: 2000, softChunkChars: 120 });
  const bindingKey = "discord:chat-1";

  const out = service.appendDelta(
    "thread-1",
    "turn-soft",
    bindingKey,
    `${"word ".repeat(35)}\n${"more ".repeat(35)}\n`
  );

  assert.equal(typeof out.sectionText, "string");
  assert.equal(out.sectionText.length > 0, true);
});

test("turn output service keeps full final text", () => {
  const service = new TurnOutputService();
  const bindingKey = "discord:chat-1";

  service.appendDelta("thread-1", "turn-2", bindingKey, "hello\n\n");
  service.appendDelta("thread-1", "turn-2", bindingKey, "world");
  const final = service.takeFinal("thread-1", "turn-2");

  assert.equal(final.fullText, "hello\n\nworld");
  assert.equal(final.pendingText, "world");
  assert.deepEqual(service.takeFinal("thread-1", "turn-2"), { fullText: "", pendingText: "" });
});
