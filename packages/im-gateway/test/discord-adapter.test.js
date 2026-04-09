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
          channel_id: "123",
          message_reference: { message_id: "1" },
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
  assert.equal(seen[0].messageId, "2");
  assert.equal(seen[0].replyToMessageId, "1");
  assert.equal(seen[0].threadId, "123");
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

test("discord adapter sends reply-anchored rich message payload", async () => {
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
      json: async () => ({ id: "msg-9", channel_id: "thread-1" }),
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
    const result = await adapter.sendMessageRich(
      { channel: "discord", chatId: "123" },
      { text: "hello", replyToMessageId: "42", threadId: "thread-1" }
    );
    assert.equal(result.messageId, "msg-9");
    assert.equal(result.chatId, "thread-1");
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].url.includes("/channels/thread-1/messages"), true);
  assert.equal(postCalls[0].body?.message_reference?.message_id, "42");
});

test("discord adapter edits an existing message", async () => {
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
      json: async () => ({ id: "msg-10", channel_id: "123" }),
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
    const result = await adapter.editMessage({ channel: "discord", chatId: "123" }, "msg-10", "updated");
    assert.equal(result.messageId, "msg-10");
    assert.equal(result.chatId, "123");
  } finally {
    global.fetch = originalFetch;
  }

  const patchCalls = calls.filter((call) => call.method === "PATCH");
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].url.includes("/channels/123/messages/msg-10"), true);
  assert.equal(patchCalls[0].body?.content, "updated");
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

test("discord adapter escapes ordered-list markers outside code fences", async () => {
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
      json: async () => ({ id: "msg-3" }),
      text: async () => "",
    };
  };

  const adapter = new DiscordAdapter({
    token: "token",
    allowedChannels: ["123"],
    minSendIntervalMs: 0,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  const text = [
    "1. Delivery",
    "2. Echo chat-only",
    "```md",
    "1. keep inside fence",
    "```",
  ].join("\n");

  try {
    await adapter.sendMessage({ channel: "discord", chatId: "123" }, text);
    await adapter.stop();
  } finally {
    global.fetch = originalFetch;
  }

  const postCalls = calls.filter((call) => call.method === "POST" && call.url.includes("/channels/123/messages"));
  assert.equal(postCalls.length, 1);
  const content = String(postCalls[0].body?.content || "");
  assert.equal(content.includes("1\\. Delivery"), true);
  assert.equal(content.includes("2\\. Echo chat-only"), true);
  assert.equal(content.includes("1. keep inside fence"), true);
});
