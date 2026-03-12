import test from "node:test";
import assert from "node:assert/strict";

import { DiscordAdapter } from "../src/discord-adapter.js";

test("discord adapter polls allowed channel and emits inbound messages", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ([
        {
          id: "2",
          content: "/status",
          author: { id: "u-1", username: "tester", bot: false },
        },
      ]),
      text: async () => "",
    };
  };

  const seen = [];
  const adapter = new DiscordAdapter({
    token: "token",
    allowedChannels: ["123"],
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
  assert.equal(seen[0].channel, "discord");
  assert.equal(seen[0].chatId, "123");
  assert.equal(seen[0].text, "/status");
  assert.equal(calls.some((url) => url.includes("/channels/123/messages")), true);
});

test("discord adapter marks unknown channels as invalid", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: "Unknown Channel", code: 10003 }),
    };
  };

  const adapter = new DiscordAdapter({
    token: "token",
    allowedChannels: ["999"],
    pollIntervalMs: 10,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });

  try {
    await adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCalls >= 1, true);
  assert.equal(adapter.invalidChannels.has("999"), true);
});
