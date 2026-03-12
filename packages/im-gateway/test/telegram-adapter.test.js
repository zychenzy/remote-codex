import test from "node:test";
import assert from "node:assert/strict";

import { TelegramAdapter } from "../src/telegram-adapter.js";

test("telegram adapter polls updates and emits inbound messages", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              text: "/status",
              chat: { id: "42" },
              from: { id: "u-2", username: "tester2" },
            },
          },
        ],
      }),
      text: async () => "",
    };
  };

  const seen = [];
  const adapter = new TelegramAdapter({
    token: "token",
    pollIntervalMs: 10,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(seen.length >= 1, true);
  assert.equal(seen[0].channel, "telegram");
  assert.equal(seen[0].chatId, "42");
  assert.equal(seen[0].text, "/status");
  assert.equal(calls.length >= 1, true);
});

test("telegram adapter sendMessage throws on API error", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
  });

  const adapter = new TelegramAdapter({
    token: "token",
    pollIntervalMs: 10,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });

  try {
    await assert.rejects(
      () => adapter.sendMessage({ chatId: "42" }, "hello"),
      /telegram sendMessage failed: 401/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
