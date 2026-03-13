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

test("discord adapter sends message payload to channel endpoint", async () => {
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
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  const context = { channel: "discord", chatId: "123", turnId: "turn-1" };

  try {
    await adapter.sendMessage(context, "hello world!");
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST" && call.url.includes("/channels/123/messages"));
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].body?.content, "hello world!");
});

test("discord adapter truncates oversized messages", async () => {
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
      json: async () => ({ id: "msg-2" }),
      text: async () => "",
    };
  };

  const adapter = new DiscordAdapter({
    token: "token",
    allowedChannels: ["123"],
    minSendIntervalMs: 0,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  const context = { channel: "discord", chatId: "123", turnId: "turn-2" };
  const oversized = "x".repeat(2200);

  try {
    await adapter.sendMessage(context, oversized);
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST" && call.url.includes("/channels/123/messages"));
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].body?.content.includes("...[truncated]"), true);
  assert.equal(postCalls[0].body?.content.length <= 1900, true);
});

test("discord adapter skips empty outbound content", async () => {
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
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });

  try {
    await adapter.sendMessage({ channel: "discord", chatId: "123" }, "   ");
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST" && call.url.includes("/channels/123/messages"));
  assert.equal(postCalls.length, 0);
});
