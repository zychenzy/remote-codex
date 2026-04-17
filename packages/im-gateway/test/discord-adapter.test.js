import test from "node:test";
import assert from "node:assert/strict";

import { DiscordAdapter } from "../src/discord-adapter.js";

function createFakeClient() {
  const events = new Map();
  const channels = new Map();
  const commandSets = [];
  let ready = false;

  const client = {
    application: {
      commands: {
        async set(defs) {
          commandSets.push(defs);
          return defs;
        },
      },
    },
    channels: {
      cache: {
        get(id) {
          return channels.get(String(id)) || null;
        },
      },
      async fetch(id) {
        const channel = channels.get(String(id));
        if (!channel) {
          throw new Error(`missing channel ${id}`);
        }
        return channel;
      },
    },
    on(event, handler) {
      const list = events.get(event) || [];
      list.push(handler);
      events.set(event, list);
    },
    once(event, handler) {
      const wrapped = (...args) => {
        const list = events.get(event) || [];
        events.set(event, list.filter((item) => item !== wrapped));
        handler(...args);
      };
      client.on(event, wrapped);
    },
    emit(event, payload) {
      const list = events.get(event) || [];
      for (const handler of list) {
        handler(payload);
      }
    },
    isReady() {
      return ready;
    },
    async login() {
      ready = true;
      client.emit("ready");
      return "token";
    },
    async destroy() {
      ready = false;
    },
    __channels: channels,
    __commandSets: commandSets,
  };

  return client;
}

function createFakeChannel({ id, parentId = null, isDm = false } = {}) {
  const sent = [];
  const storedMessages = new Map();
  let nextMessageId = 1;

  function createStoredMessage(messageId, payload = {}) {
    const record = {
      id: String(messageId),
      channelId: String(id),
      content: String(payload.content || ""),
      embeds: payload.embeds || [],
      components: payload.components || [],
      reply: payload.reply || null,
      async edit(nextPayload = {}) {
        if (Object.prototype.hasOwnProperty.call(nextPayload, "content")) {
          record.content = String(nextPayload.content || "");
        }
        if (Array.isArray(nextPayload.embeds)) {
          record.embeds = nextPayload.embeds;
        }
        if (Array.isArray(nextPayload.components)) {
          record.components = nextPayload.components;
        }
        return record;
      },
    };
    storedMessages.set(record.id, record);
    return record;
  }

  return {
    id: String(id),
    parentId: parentId ? String(parentId) : null,
    parent: parentId ? { id: String(parentId) } : null,
    sent,
    messages: {
      async fetch(messageId) {
        if (!storedMessages.has(String(messageId))) {
          return createStoredMessage(messageId, {});
        }
        return storedMessages.get(String(messageId));
      },
    },
    isDMBased() {
      return isDm;
    },
    async send(payload = {}) {
      const message = createStoredMessage(`msg-${nextMessageId++}`, payload);
      sent.push(message);
      return message;
    },
  };
}

function createMessage({ id, content, channel, authorId = "user-1", userName = "tester", bot = false, replyToMessageId = "" } = {}) {
  return {
    id: String(id || "m-1"),
    content: String(content || ""),
    channel,
    guild: channel.isDMBased() ? null : { id: "guild-1" },
    author: {
      id: String(authorId),
      username: userName,
      bot,
    },
    reference: replyToMessageId ? { messageId: String(replyToMessageId) } : null,
  };
}

function createOptions({ subcommand = "", values = {} } = {}) {
  return {
    getSubcommand() {
      return subcommand;
    },
    getString(name) {
      return values[name] ?? null;
    },
    getInteger(name) {
      return values[name] ?? null;
    },
    getBoolean(name) {
      return values[name] ?? null;
    },
  };
}

function createSlashInteraction({ commandName, options, channel, userId = "user-1", userName = "tester" } = {}) {
  const replies = [];
  return {
    id: "interaction-1",
    commandName,
    options,
    channel,
    channelId: channel.id,
    guild: channel.isDMBased() ? null : { id: "guild-1" },
    user: { id: userId, username: userName, displayName: userName },
    replied: false,
    responded: false,
    deferred: false,
    replies,
    isChatInputCommand() {
      return true;
    },
    isButton() {
      return false;
    },
    isStringSelectMenu() {
      return false;
    },
    async reply(payload = {}) {
      this.replied = true;
      this.responded = true;
      replies.push(payload);
      return {
        id: "reply-1",
        channelId: channel.id,
      };
    },
    async editReply(payload = {}) {
      replies.push(payload);
      return {
        id: "reply-1",
        channelId: channel.id,
      };
    },
    async followUp(payload = {}) {
      replies.push(payload);
      return payload;
    },
  };
}

function createComponentInteraction({
  kind = "button",
  customId,
  values = [],
  channel,
  message,
  userId = "user-1",
  userName = "tester",
} = {}) {
  const replies = [];
  const updates = [];
  let deferred = false;
  return {
    id: "component-1",
    customId,
    values,
    channel,
    channelId: channel.id,
    guild: channel.isDMBased() ? null : { id: "guild-1" },
    message,
    user: { id: userId, username: userName, displayName: userName },
    replied: false,
    deferred: false,
    replies,
    updates,
    isChatInputCommand() {
      return false;
    },
    isButton() {
      return kind === "button";
    },
    isStringSelectMenu() {
      return kind === "select";
    },
    async reply(payload = {}) {
      this.replied = true;
      replies.push(payload);
      return payload;
    },
    async followUp(payload = {}) {
      replies.push(payload);
      return payload;
    },
    async update(payload = {}) {
      updates.push(payload);
      if (Object.prototype.hasOwnProperty.call(payload, "content")) {
        message.content = String(payload.content || "");
      }
      if (Array.isArray(payload.embeds)) {
        message.embeds = payload.embeds;
      }
      if (Array.isArray(payload.components)) {
        message.components = payload.components;
      }
      return message;
    },
    async deferUpdate() {
      deferred = true;
      this.deferred = true;
    },
    get __deferred() {
      return deferred;
    },
  };
}

function createAdapter({ client, authorizeInteraction = null, allowedChannels = ["123"], dmUserIds = ["user-1"] } = {}) {
  return new DiscordAdapter({
    token: "token",
    client,
    allowedChannels,
    dmUserIds,
    authorizeInteraction,
    minSendIntervalMs: 0,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
}

test("discord adapter handles allowed channel messages through gateway events", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"], dmUserIds: ["user-1"] });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  await adapter.start();
  client.emit("messageCreate", createMessage({
    id: "m-2",
    content: "/status",
    channel,
    replyToMessageId: "m-1",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].chatId, "123");
  assert.equal(seen[0].text, "/status");
  assert.equal(seen[0].replyToMessageId, "m-1");
});

test("discord adapter handles allowlisted DM messages", async () => {
  const client = createFakeClient();
  const dm = createFakeChannel({ id: "dm-1", isDm: true });
  client.__channels.set("dm-1", dm);
  const adapter = createAdapter({ client, allowedChannels: [], dmUserIds: ["user-7"] });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  await adapter.start();
  client.emit("messageCreate", createMessage({
    id: "dm-msg-1",
    content: "/status",
    channel: dm,
    authorId: "user-7",
    userName: "dm-user",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].chatId, "dm-1");
  assert.equal(seen[0].userId, "user-7");
});

test("discord adapter ignores bot messages", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"], dmUserIds: ["user-1"] });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  await adapter.start();
  client.emit("messageCreate", createMessage({ id: "m-2", content: "/status", channel, bot: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();

  assert.equal(seen.length, 0);
});

test("discord adapter sends message payload to channel via discord.js", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });

  const result = await adapter.sendMessage({ channel: "discord", chatId: "123" }, "hello world!");

  assert.equal(result.messageId, "msg-1");
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, "hello world!");
});

test("discord adapter sends reply-anchored rich message payload", async () => {
  const client = createFakeClient();
  const thread = createFakeChannel({ id: "thread-1", parentId: "123" });
  client.__channels.set("thread-1", thread);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });

  const result = await adapter.sendMessageRich(
    { channel: "discord", chatId: "123" },
    { text: "hello", replyToMessageId: "42", threadId: "thread-1" }
  );

  assert.equal(result.chatId, "thread-1");
  assert.equal(thread.sent.length, 1);
  assert.equal(thread.sent[0].reply?.messageReference, "42");
});

test("discord adapter edits an existing message", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const message = await channel.send({ content: "before" });
  const adapter = createAdapter({ client, allowedChannels: ["123"] });

  const result = await adapter.editMessage({ channel: "discord", chatId: "123" }, message.id, "updated");

  assert.equal(result.messageId, message.id);
  assert.equal(message.content, "updated");
});

test("discord adapter truncates oversized messages and skips empty outbound content", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });

  await adapter.sendMessage({ channel: "discord", chatId: "123" }, "x".repeat(2200));
  await adapter.sendMessage({ channel: "discord", chatId: "123" }, "   ");

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content.includes("...[truncated]"), true);
  assert.equal(channel.sent[0].content.length <= 1900, true);
});

test("discord adapter escapes ordered-list markers outside code fences", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });
  const text = [
    "1. Delivery",
    "2. Echo chat-only",
    "```md",
    "1. keep inside fence",
    "```",
  ].join("\n");

  await adapter.sendMessage({ channel: "discord", chatId: "123" }, text);

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content.includes("1\\. Delivery"), true);
  assert.equal(channel.sent[0].content.includes("2\\. Echo chat-only"), true);
  assert.equal(channel.sent[0].content.includes("1. keep inside fence"), true);
});

test("discord adapter syncs native slash commands on startup and degrades on sync failure", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);

  const adapter = createAdapter({ client, allowedChannels: ["123"] });
  await adapter.start();
  await adapter.stop();
  assert.equal(client.__commandSets.length, 1);
  assert.equal(client.__commandSets[0].some((entry) => entry.name === "model"), true);
  const cwdCommand = client.__commandSets[0].find((entry) => entry.name === "cwd");
  assert.equal(cwdCommand.options[0].required, false);
  const searchCommand = client.__commandSets[0].find((entry) => entry.name === "search");
  assert.equal(searchCommand.options[0].required, true);

  const failingClient = createFakeClient();
  failingClient.__channels.set("123", channel);
  let warned = false;
  failingClient.application.commands.set = async () => {
    throw new Error("sync failed");
  };
  const adapter2 = new DiscordAdapter({
    token: "token",
    client: failingClient,
    allowedChannels: ["123"],
    dmUserIds: ["user-1"],
    minSendIntervalMs: 0,
    logger: { warn() { warned = true; }, error() {}, info() {}, debug() {} },
  });
  await adapter2.start();
  await adapter2.stop();
  assert.equal(warned, true);
});

test("discord adapter normalizes native slash commands into canonical text commands", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  await adapter.start();
  client.emit("interactionCreate", createSlashInteraction({
    commandName: "model",
    options: createOptions({ subcommand: "set", values: { value: "gpt-5.4" } }),
    channel,
  }));
  client.emit("interactionCreate", createSlashInteraction({
    commandName: "search",
    options: createOptions({ values: { query: "daemon-app" } }),
    channel,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();

  assert.equal(seen.length, 2);
  assert.equal(seen[0].text, "/model set gpt-5.4");
  assert.equal(seen[1].text, "/search daemon-app");
  assert.equal(seen[0].discordMeta.kind, "slash");
});

test("discord adapter uses interaction reply for the first slash-command response", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });
  const interaction = createSlashInteraction({
    commandName: "status",
    options: createOptions(),
    channel,
  });
  const context = {
    channel: "discord",
    chatId: "123",
    threadId: "123",
    raw: interaction,
    discordMeta: { kind: "slash", responded: false },
  };

  await adapter.sendMessageRich(context, { text: "Status sent." });
  await adapter.sendMessageRich(context, { text: "Second response." });

  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].content, "Status sent.");
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, "Second response.");
});

test("discord adapter renders approval buttons and emits canonical approval commands", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.sendApprovalPrompt(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        localRequestId: "req-1",
        kind: "item/commandExecution/requestApproval",
        summary: "Run npm test",
      }
    );

    assert.equal(channel.sent.length, 1);
    const message = channel.sent[0];
    const buttonId = message.components[0].components[0].custom_id;
    const interaction = createComponentInteraction({
      kind: "button",
      customId: buttonId,
      channel,
      message,
    });

    client.emit("interactionCreate", interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, "/approve req-1 allow");
    assert.equal(interaction.updates.length, 1);
    assert.equal(interaction.updates[0].components[0].components.every((entry) => entry.disabled), true);
  } finally {
    await adapter.stop();
  }
});

test("discord adapter renders tool input selects and emits canonical answer commands", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.sendApprovalPrompt(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        localRequestId: "req-input",
        kind: "item/tool/requestUserInput",
        summary: "Need selections",
        questions: [
          { id: "mode", question: "Choose mode", options: ["fast", "safe"] },
          { id: "target", question: "Choose target", options: ["tests", "docs"] },
        ],
      }
    );

    const message = channel.sent[0];
    const firstSelect = message.components[0].components[0].custom_id;
    const secondSelect = message.components[1].components[0].custom_id;
    const submitButton = message.components[2].components[0].custom_id;

    const firstSelection = createComponentInteraction({
      kind: "select",
      customId: firstSelect,
      values: ["o1"],
      channel,
      message,
    });
    const secondSelection = createComponentInteraction({
      kind: "select",
      customId: secondSelect,
      values: ["o0"],
      channel,
      message,
    });
    client.emit("interactionCreate", firstSelection);
    client.emit("interactionCreate", secondSelection);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const submit = createComponentInteraction({
      kind: "button",
      customId: submitButton,
      channel,
      message,
    });
    client.emit("interactionCreate", submit);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, "/answer req-input mode=safe;target=tests");
    assert.equal(firstSelection.__deferred, true);
    assert.equal(secondSelection.__deferred, true);
    assert.equal(firstSelection.replies.length, 0);
    assert.equal(secondSelection.replies.length, 0);
    assert.equal(submit.updates.length, 1);
  } finally {
    await adapter.stop();
  }
});

test("discord adapter renders generic command controls and maps select/button actions to text commands", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.sendMessageRich(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        text: "Threads:\n1. Alpha",
        nativeUi: {
          kind: "threadList",
          title: "Threads",
          description: "Choose a thread",
          components: {
            selects: [{
              placeholder: "Resume",
              options: [{ label: "Alpha", description: "/repo", commandText: "/resume thread-1" }],
            }],
            buttons: [{ label: "Next Page", style: 1, commandText: "/thread more" }],
          },
        },
      }
    );

    const message = channel.sent[0];
    const buttonId = message.components[0].components[0].custom_id;
    const selectId = message.components[1].components[0].custom_id;

    client.emit("interactionCreate", createComponentInteraction({
      kind: "select",
      customId: selectId,
      values: ["o0"],
      channel,
      message,
    }));
    client.emit("interactionCreate", createComponentInteraction({
      kind: "button",
      customId: buttonId,
      channel,
      message,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(seen.map((entry) => entry.text), ["/resume thread-1", "/thread more"]);
  } finally {
    await adapter.stop();
  }
});

test("discord adapter renders cwd browser controls and confirms selected directory", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.sendMessageRich(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        text: "/Users/czy/auto",
        nativeUi: {
          kind: "cwdBrowser",
          title: "Browse Workspace",
          description: "Current workspace: /Users/czy/auto",
          components: {
            selects: [{
              placeholder: "Select a subdirectory",
              options: [{ label: "packages", description: "/Users/czy/auto/packages", path: "/Users/czy/auto/packages" }],
            }],
            buttons: [
              { label: "Confirm", style: 3 },
              { label: "Cancel", style: 4 },
            ],
          },
        },
      }
    );

    const message = channel.sent[0];
    const selectId = message.components[0].components[0].custom_id;
    const confirmId = message.components[1].components[0].custom_id;

    const selectInteraction = createComponentInteraction({
      kind: "select",
      customId: selectId,
      values: ["o0"],
      channel,
      message,
    });
    client.emit("interactionCreate", selectInteraction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmInteraction = createComponentInteraction({
      kind: "button",
      customId: confirmId,
      channel,
      message,
    });
    client.emit("interactionCreate", confirmInteraction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(selectInteraction.updates.length, 1);
    assert.equal(String(selectInteraction.updates[0].embeds[0].description || "").includes("Selected: /Users/czy/auto/packages"), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, "/cwd /Users/czy/auto/packages");
    assert.equal(confirmInteraction.updates.length, 1);
  } finally {
    await adapter.stop();
  }
});

test("discord adapter updates component response in place and channel-sends after deferred component interaction", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({ client, allowedChannels: ["123"] });
  const message = await channel.send({ content: "before" });
  const component = createComponentInteraction({
    kind: "select",
    customId: "reco:test:s0",
    channel,
    message,
  });

  await adapter.sendMessageRich(
    {
      channel: "discord",
      chatId: "123",
      threadId: "123",
      raw: component,
      discordMeta: { kind: "select", responded: false },
    },
    { text: "updated in place" }
  );

  assert.equal(component.updates.length, 1);
  assert.equal(message.content, "updated in place");

  const deferred = createComponentInteraction({
    kind: "button",
    customId: "reco:test:b0",
    channel,
    message,
  });
  await deferred.deferUpdate();
  await adapter.sendMessageRich(
    {
      channel: "discord",
      chatId: "123",
      threadId: "123",
      raw: deferred,
      discordMeta: { kind: "button", responded: false },
    },
    { text: "preview output" }
  );

  assert.equal(channel.sent.some((item) => item.content === "preview output"), true);
});

test("discord adapter renders file picker controls for browse and preview flow", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => true,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  try {
    await adapter.sendMessageRich(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        text: "Files",
        nativeUi: {
          kind: "filePicker",
          mode: "browser",
          rootDir: "/Users/czy/auto",
          currentDir: "/Users/czy/auto",
          parentDir: "/Users/czy",
          canGoUp: false,
          components: {
            selects: [{
              options: [
                { label: "packages/", description: "dir", path: "/Users/czy/auto/packages", entryType: "dir" },
                { label: "README.md", description: "file", path: "/Users/czy/auto/README.md", entryType: "file" },
              ],
            }],
          },
        },
      }
    );

    const message = channel.sent[0];
    const selectId = message.components[0].components[0].custom_id;
    const buttonRow = message.components[1].components;
    const previewId = buttonRow.find((entry) => entry.label === "Preview").custom_id;

    client.emit("interactionCreate", createComponentInteraction({
      kind: "select",
      customId: selectId,
      values: ["o0"],
      channel,
      message,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text.startsWith("/files --dir64 "), true);

    const fileSelection = createComponentInteraction({
      kind: "select",
      customId: selectId,
      values: ["o1"],
      channel,
      message,
    });
    client.emit("interactionCreate", fileSelection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fileSelection.updates.length, 1);
    assert.equal(String(fileSelection.updates[0].embeds[0].description || "").includes("Selected file: /Users/czy/auto/README.md"), true);

    const previewInteraction = createComponentInteraction({
      kind: "button",
      customId: previewId,
      channel,
      message,
    });
    client.emit("interactionCreate", previewInteraction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(previewInteraction.__deferred, true);
    assert.equal(seen.some((entry) => entry.text.includes("--preview64")), true);
  } finally {
    await adapter.stop();
  }
});

test("discord adapter rejects unauthorized slash and component interactions ephemerally", async () => {
  const client = createFakeClient();
  const channel = createFakeChannel({ id: "123" });
  client.__channels.set("123", channel);
  const adapter = createAdapter({
    client,
    allowedChannels: ["123"],
    authorizeInteraction: async () => false,
  });
  const seen = [];
  adapter.registerInboundHandler((context) => seen.push(context));

  await adapter.start();
  try {
    const slash = createSlashInteraction({
      commandName: "status",
      options: createOptions(),
      channel,
    });
    client.emit("interactionCreate", slash);

    await adapter.sendApprovalPrompt(
      { channel: "discord", chatId: "123", threadId: "123" },
      {
        localRequestId: "req-unauth",
        kind: "item/commandExecution/requestApproval",
        summary: "Run tests",
      }
    );
    const message = channel.sent[0];
    const buttonId = message.components[0].components[0].custom_id;
    const component = createComponentInteraction({
      kind: "button",
      customId: buttonId,
      channel,
      message,
    });
    client.emit("interactionCreate", component);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(seen.length, 0);
    assert.equal(slash.replies.length, 1);
    assert.equal(component.replies.length, 1);
    assert.equal(String(component.replies[0].content || "").includes("Unauthorized"), true);
  } finally {
    await adapter.stop();
  }
});
