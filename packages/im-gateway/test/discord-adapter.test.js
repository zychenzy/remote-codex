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

test("discord adapter streams by editing a single message", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET");
    let body = null;
    if (typeof options.body === "string" && options.body) {
      body = JSON.parse(options.body);
    }
    calls.push({ url: String(url), method, body });

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg-1" }),
      text: async () => "",
    };
  };

  const adapter = new DiscordAdapter({
    token: "token",
    allowedChannels: ["123"],
    minSendIntervalMs: 0,
    streamEditIntervalMs: 20,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  const context = { channel: "discord", chatId: "123", turnId: "turn-1" };

  try {
    await adapter.sendStreamingDelta(context, "hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await adapter.sendStreamingDelta(context, " world");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await adapter.flushStreamingMessage(context, { finalText: "hello world!" });
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST" && call.url.includes("/channels/123/messages"));
  const patchCalls = calls.filter((call) => call.method === "PATCH" && call.url.includes("/channels/123/messages/msg-1"));
  assert.equal(postCalls.length, 1);
  assert.equal(patchCalls.length >= 1, true);
  assert.equal(patchCalls[patchCalls.length - 1].body?.content, "hello world!");
});
