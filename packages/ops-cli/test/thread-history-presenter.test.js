import test from "node:test";
import assert from "node:assert/strict";

import { ThreadHistoryPresenter } from "../src/thread-history-presenter.js";

test("thread history presenter renders user and agent turns", async () => {
  const runtime = {
    readThread: async () => ({
      thread: {
        turns: [
          {
            items: [
              { type: "userMessage", content: [{ type: "text", text: "hello" }] },
              { type: "agentMessage", content: [{ type: "text", text: "world" }] },
            ],
          },
        ],
      },
    }),
  };

  const presenter = new ThreadHistoryPresenter({
    runtime,
    logger: { debug: () => {} },
    sendMessage: async () => {},
    sendLongMessage: async () => {},
  });

  const messages = await presenter.renderMessages("thread-1", {});
  assert.equal(messages.length, 2);
  assert.equal(messages[0], "Thread history (1 turns):");
  assert.equal(messages[1].includes("◇ hello"), true);
  assert.equal(messages[1].includes("• world"), true);
});

test("thread history presenter sends long blocks via sendLongMessage", async () => {
  const runtime = {
    readThread: async () => ({
      thread: {
        turns: [
          {
            items: [
              { type: "agentMessage", content: [{ type: "text", text: "x".repeat(2200) }] },
            ],
          },
        ],
      },
    }),
  };

  const sent = [];
  const longSent = [];
  const presenter = new ThreadHistoryPresenter({
    runtime,
    logger: { debug: () => {} },
    sendMessage: async (_adapter, _context, text) => sent.push(text),
    sendLongMessage: async (_adapter, _context, text) => longSent.push(text),
  });

  await presenter.send({ channel: "discord" }, { channel: "discord", chatId: "1" }, "thread-2");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].startsWith("Thread history"), true);
  assert.equal(longSent.length, 1);
});
