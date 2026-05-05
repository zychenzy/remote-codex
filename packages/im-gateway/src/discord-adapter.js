import crypto from "node:crypto";

import * as DiscordJs from "discord.js";

import { BaseAdapter } from "./base-adapter.js";

const DISCORD_MAX_CONTENT = 1900;
const VIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MIN_SEND_INTERVAL_MS = 450;
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;
const INBOUND_DEDUP_MAX = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stabilizeDiscordMarkdown(text) {
  const raw = String(text || "");
  if (!raw) {
    return "";
  }

  const lines = raw.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(line.replace(/^(\s*)(\d+)\.(\s+)/, "$1$2\\.$3"));
  }
  return out.join("\n");
}

function formatDiscordContent(text) {
  const raw = stabilizeDiscordMarkdown(text);
  if (!raw) {
    return "";
  }
  if (raw.length <= DISCORD_MAX_CONTENT) {
    return raw;
  }
  const suffix = "\n...[truncated]";
  const keep = Math.max(0, DISCORD_MAX_CONTENT - suffix.length);
  return `${raw.slice(0, keep)}${suffix}`;
}

function normalizeMessageRef(raw = {}) {
  const messageId = String(raw?.messageId || raw?.id || "").trim();
  const targetChatId = String(raw?.chatId || raw?.channelId || raw?.channel_id || "").trim();
  return {
    messageId,
    chatId: targetChatId,
  };
}

function nowMs() {
  return Date.now();
}

function shortId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function encodeCommandValue(value = "") {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function row(components) {
  return {
    type: 1,
    components,
  };
}

function button({
  customId,
  label,
  style = 2,
  emoji = undefined,
  disabled = false,
}) {
  return {
    type: 2,
    custom_id: customId,
    label,
    style,
    ...(emoji ? { emoji } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

function stringSelect({
  customId,
  placeholder,
  options,
  minValues = 1,
  maxValues = 1,
  disabled = false,
}) {
  return {
    type: 3,
    custom_id: customId,
    placeholder,
    options,
    min_values: minValues,
    max_values: maxValues,
    ...(disabled ? { disabled: true } : {}),
  };
}

function selectOption({ label, value, description = "", defaultValue = false }) {
  return {
    label: String(label || "").slice(0, 100),
    value: String(value || "").slice(0, 100),
    ...(description ? { description: String(description).slice(0, 100) } : {}),
    ...(defaultValue ? { default: true } : {}),
  };
}

function plainEmbed({ title = "", description = "", color = 0x5865f2, footer = "" } = {}) {
  return {
    title: String(title || "").slice(0, 256),
    description: String(description || "").slice(0, 4096),
    color,
    ...(footer ? { footer: { text: String(footer || "").slice(0, 2048) } } : {}),
  };
}

function disableComponents(components = []) {
  return components.map((entry) => ({
    ...entry,
    components: Array.isArray(entry?.components)
      ? entry.components.map((component) => ({ ...component, disabled: true }))
      : [],
  }));
}

function firstLine(text = "") {
  return String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function stringifyOptionLabel(option) {
  if (typeof option === "string") {
    return option.trim();
  }
  if (option && typeof option === "object") {
    return String(option.label || option.value || option.id || "").trim();
  }
  return "";
}

function isThreadChannel(channel) {
  if (!channel) {
    return false;
  }
  if (typeof channel.isThread === "function") {
    return channel.isThread();
  }
  return Boolean(channel.parentId || channel.parent);
}

function optionType(discordApi, key, fallback) {
  return discordApi?.ApplicationCommandOptionType?.[key] ?? fallback;
}

function capitalize(word = "") {
  const input = String(word || "");
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : "";
}

export class DiscordAdapter extends BaseAdapter {
  constructor({
    token,
    allowedChannels = [],
    dmUserIds = [],
    loadCursor = null,
    saveCursor = null,
    pollIntervalMs = 1800,
    minSendIntervalMs = DEFAULT_MIN_SEND_INTERVAL_MS,
    logger = console,
    discordApi = DiscordJs,
    client = null,
    authorizeInteraction = null,
  } = {}) {
    super({ channel: "discord", logger });
    this.token = token;
    this.allowedChannels = Array.isArray(allowedChannels) ? allowedChannels.map((value) => String(value || "").trim()).filter(Boolean) : [];
    this.allowedUserIds = Array.isArray(dmUserIds) ? dmUserIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
    this.loadCursor = loadCursor;
    this.saveCursor = saveCursor;
    this.pollIntervalMs = pollIntervalMs;
    this.minSendIntervalMs = minSendIntervalMs;
    this.discordApi = discordApi;
    this.authorizeInteraction = authorizeInteraction;
    this.client = client || this.#createClient();
    this.sendQueue = Promise.resolve();
    this.nextAllowedSendAt = 0;
    this.started = false;
    this.readyPromise = null;
    this.viewState = new Map();
    this.seenInboundKeys = new Map();
    this.clientHandlersInstalled = false;
    this.#ensureClientHandlers();
  }

  emitInbound(context) {
    if (!this.#markInboundOnce(context)) {
      this.logger.debug?.("[discord] dropped duplicate inbound event");
      return;
    }
    super.emitInbound(context);
  }

  #markInboundOnce(context) {
    const key = this.#inboundDedupKey(context);
    if (!key) {
      return true;
    }
    const now = Date.now();
    const expiresAt = this.seenInboundKeys.get(key) || 0;
    if (expiresAt > now) {
      return false;
    }
    this.seenInboundKeys.set(key, now + INBOUND_DEDUP_TTL_MS);
    this.#pruneInboundDedup(now);
    return true;
  }

  #inboundDedupKey(context) {
    const meta = context?.discordMeta || {};
    const interactionId = String(meta.interactionId || "").trim();
    const messageId = String(context?.messageId || "").trim();
    const id = interactionId ? `interaction:${interactionId}` : (messageId ? `message:${messageId}` : "");
    if (!id) {
      return "";
    }
    return [
      id,
      String(meta.kind || ""),
      String(context?.chatId || ""),
      String(context?.userId || ""),
      String(context?.text || "").trim(),
    ].join("|");
  }

  #pruneInboundDedup(now = Date.now()) {
    if (this.seenInboundKeys.size <= INBOUND_DEDUP_MAX) {
      return;
    }
    for (const [key, expiresAt] of this.seenInboundKeys) {
      if (expiresAt <= now || this.seenInboundKeys.size > INBOUND_DEDUP_MAX) {
        this.seenInboundKeys.delete(key);
      }
      if (this.seenInboundKeys.size <= INBOUND_DEDUP_MAX) {
        break;
      }
    }
  }

  #createClient() {
    const intents = [
      this.discordApi?.GatewayIntentBits?.Guilds ?? 1,
      this.discordApi?.GatewayIntentBits?.GuildMessages ?? 512,
      this.discordApi?.GatewayIntentBits?.MessageContent ?? 32768,
      this.discordApi?.GatewayIntentBits?.DirectMessages ?? 4096,
    ];
    const partials = [];
    const dmPartial = this.discordApi?.Partials?.Channel;
    if (dmPartial != null) {
      partials.push(dmPartial);
    }
    return new this.discordApi.Client({ intents, partials });
  }

  async start() {
    if (!this.token) {
      this.logger.warn("[discord] token missing; adapter disabled");
      return;
    }
    if (!this.allowedChannels.length && !this.allowedUserIds.length) {
      this.logger.warn("[discord] no allowed channels or DM users configured; adapter idle");
      return;
    }
    this.#ensureClientHandlers();
    if (this.started) {
      return;
    }
    this.readyPromise = this.#waitForReady();
    try {
      await this.client.login(this.token);
      await this.readyPromise;
    } catch (error) {
      this.logger.error(`[discord] failed to start gateway client: ${error.message}`);
      throw error;
    }
    this.started = true;
    await this.#syncSlashCommands();
  }

  async stop() {
    this.started = false;
    for (const state of this.viewState.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.viewState.clear();
    if (typeof this.client.destroy === "function") {
      await this.client.destroy();
    }
  }

  async sendMessage(context, text) {
    return this.sendMessageRich(context, { text });
  }

  async sendMessageRich(context, payload = {}) {
    const prepared = this.#prepareOutboundPayload(context, payload);
    if (!String(prepared.content || "").trim() && !prepared.embeds.length && !prepared.components.length) {
      return null;
    }

    let sent = null;
    await this.#enqueueSend(async () => {
      const interaction = this.#interactionForContext(context);
      const interactionKind = String(context?.discordMeta?.kind || "");
      const isComponentInteraction = interactionKind === "button" || interactionKind === "select";
      if (interaction && isComponentInteraction && !interaction.responded && !interaction.deferred && typeof interaction.update === "function") {
        sent = await interaction.update({
          content: prepared.content || undefined,
          embeds: prepared.embeds,
          components: prepared.components,
          allowedMentions: { repliedUser: false },
        });
        interaction.responded = true;
        if (context?.discordMeta) {
          context.discordMeta.responded = true;
        }
      } else if (interaction && !interaction.responded && !interaction.deferred) {
        sent = await interaction.reply({
          content: prepared.content || undefined,
          embeds: prepared.embeds,
          components: prepared.components,
          allowedMentions: { repliedUser: false },
          fetchReply: true,
        });
        interaction.responded = true;
        if (context?.discordMeta) {
          context.discordMeta.responded = true;
        }
      } else if (interaction && interaction.deferred && !interaction.replied && !isComponentInteraction) {
        sent = await interaction.editReply({
          content: prepared.content || undefined,
          embeds: prepared.embeds,
          components: prepared.components,
          allowedMentions: { repliedUser: false },
        });
        if (context?.discordMeta) {
          context.discordMeta.responded = true;
        }
      } else {
        const channel = await this.#resolveChannel(String(payload.threadId || context.threadId || context.chatId || "").trim());
        sent = await channel.send(this.#toChannelSendPayload(prepared, payload, context));
      }
    });

    const messageRef = normalizeMessageRef({
      messageId: sent?.id || context?.messageId,
      chatId: String(sent?.channelId || payload.threadId || context.threadId || context.chatId || ""),
    });
    if (prepared.nativeUi) {
      this.#finalizeViewRegistration(prepared.nativeUi, {
        ...messageRef,
        channelId: messageRef.chatId,
      });
    }
    return messageRef;
  }

  async editMessage(context, messageId, text) {
    const content = formatDiscordContent(text);
    const resolvedMessageId = String(messageId || "").trim();
    if (!resolvedMessageId || !content.trim()) {
      return null;
    }

    const targetChatId = String(context.threadId || context.chatId || "").trim();
    let edited = null;
    await this.#enqueueSend(async () => {
      const channel = await this.#resolveChannel(targetChatId);
      const message = await channel.messages.fetch(resolvedMessageId);
      edited = await message.edit({ content });
    });

    return normalizeMessageRef({
      messageId: edited?.id || resolvedMessageId,
      chatId: String(edited?.channelId || targetChatId),
    });
  }

  async sendApprovalPrompt(context, approvalRequest) {
    if (approvalRequest?.kind === "item/tool/requestUserInput") {
      const nativePayload = this.#buildQuestionPromptPayload(context, approvalRequest);
      if (nativePayload) {
        await this.sendMessageRich(context, nativePayload);
        return;
      }
    }

    if (
      approvalRequest?.kind === "item/commandExecution/requestApproval"
      || approvalRequest?.kind === "item/fileChange/requestApproval"
    ) {
      await this.sendMessageRich(context, this.#buildApprovalPromptPayload(context, approvalRequest));
      return;
    }

    await super.sendApprovalPrompt(context, approvalRequest);
  }

  #prepareOutboundPayload(_context, payload = {}) {
    const content = formatDiscordContent(payload.text || "");
    const embeds = [];
    const components = [];
    let nativeUi = null;

    if (payload.nativeUi) {
      const rendered = this.#renderNativeUi(payload.nativeUi, { fallbackText: content });
      if (rendered.embed) {
        embeds.push(rendered.embed);
      }
      if (rendered.components?.length) {
        components.push(...rendered.components);
      }
      nativeUi = rendered.state || null;
    }

    return {
      content,
      embeds,
      components,
      nativeUi,
    };
  }

  #toChannelSendPayload(prepared, payload, context) {
    const out = {
      ...(prepared.content ? { content: prepared.content } : {}),
      ...(prepared.embeds.length ? { embeds: prepared.embeds } : {}),
      ...(prepared.components.length ? { components: prepared.components } : {}),
      allowedMentions: { repliedUser: false },
    };
    const replyToMessageId = String(payload.replyToMessageId || context.replyToMessageId || "").trim();
    if (replyToMessageId) {
      out.reply = {
        messageReference: replyToMessageId,
      };
    }
    return out;
  }

  #interactionForContext(context) {
    const meta = context?.discordMeta;
    const raw = context?.raw;
    if (!meta || meta.responded || !raw) {
      return null;
    }
    if (!["slash", "button", "select"].includes(String(meta.kind || ""))) {
      return null;
    }
    return raw;
  }

  async #enqueueSend(operation) {
    this.sendQueue = this.sendQueue
      .catch(() => {})
      .then(async () => {
        const waitMs = this.nextAllowedSendAt - Date.now();
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        await operation();
        this.nextAllowedSendAt = Date.now() + this.minSendIntervalMs;
      });
    await this.sendQueue;
  }

  #installClientHandlers() {
    this.client.on("messageCreate", (message) => {
      this.#handleMessageCreate(message).catch((error) => {
        this.logger.error(`[discord] messageCreate handler failed: ${error.message}`);
      });
    });
    this.client.on("interactionCreate", (interaction) => {
      this.#handleInteractionCreate(interaction).catch((error) => {
        this.logger.error(`[discord] interaction handler failed: ${error.message}`);
      });
    });
  }

  #ensureClientHandlers() {
    if (this.clientHandlersInstalled) {
      return;
    }
    this.#installClientHandlers();
    this.clientHandlersInstalled = true;
  }

  #waitForReady() {
    if (typeof this.client.isReady === "function" && this.client.isReady()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const event = typeof this.client.once === "function" ? "ready" : null;
      if (!event) {
        resolve();
        return;
      }
      this.client.once(event, () => resolve());
    });
  }

  async #syncSlashCommands() {
    const target = this.client?.application?.commands;
    if (!target || typeof target.set !== "function") {
      return;
    }
    try {
      await target.set(this.#buildSlashCommands());
    } catch (error) {
      this.logger.warn(`[discord] failed to sync slash commands: ${error.message}`);
    }
  }

  #buildSlashCommands() {
    const ApplicationCommandOptionType = this.discordApi?.ApplicationCommandOptionType || {};
    const STRING = optionType(this.discordApi, "String", ApplicationCommandOptionType.String ?? 3);
    const INTEGER = optionType(this.discordApi, "Integer", ApplicationCommandOptionType.Integer ?? 4);
    const BOOLEAN = optionType(this.discordApi, "Boolean", ApplicationCommandOptionType.Boolean ?? 5);
    const SUB = optionType(this.discordApi, "Subcommand", ApplicationCommandOptionType.Subcommand ?? 1);

    return [
      { name: "new", description: "Start a new thread for this chat binding." },
      {
        name: "resume",
        description: "Attach to an existing thread.",
        options: [{ type: STRING, name: "thread_id", description: "Existing thread id.", required: true }],
      },
      { name: "status", description: "Show binding/thread/runtime status." },
      {
        name: "archive",
        description: "Archive current or specified thread.",
        options: [{ type: STRING, name: "thread_id", description: "Thread id.", required: false }],
      },
      {
        name: "cwd",
        description: "Set or browse workspace directory.",
        options: [{ type: STRING, name: "path", description: "Absolute path, relative path, or ~ path.", required: false }],
      },
      { name: "files", description: "Browse files in the current workspace." },
      {
        name: "search",
        description: "Search current workspace recursively for files.",
        options: [{ type: STRING, name: "query", description: "File name or path fragment.", required: true }],
      },
      {
        name: "help",
        description: "Show help for a command.",
        options: [{ type: STRING, name: "topic", description: "Command topic.", required: false }],
      },
      { name: "interrupt", description: "Interrupt the active turn." },
      {
        name: "plan",
        description: "Toggle plan mode.",
        options: [{ type: STRING, name: "action", description: "on, off, or show", required: false }],
      },
      {
        name: "autopilot",
        description: "Autopilot controls.",
        options: [
          { type: SUB, name: "status", description: "Show autopilot status." },
          { type: SUB, name: "on", description: "Enable autopilot." },
          { type: SUB, name: "off", description: "Disable autopilot." },
          {
            type: SUB,
            name: "continue",
            description: "Configure continuation mode.",
            options: [{ type: STRING, name: "value", description: "on or off", required: true }],
          },
          {
            type: SUB,
            name: "mode",
            description: "Configure autopilot mode.",
            options: [{ type: STRING, name: "value", description: "conservative or aggressive", required: true }],
          },
        ],
      },
      {
        name: "thread",
        description: "Thread operations.",
        options: [
          {
            type: SUB,
            name: "start",
            description: "Start a new thread.",
            options: [
              { type: STRING, name: "cwd", description: "Workspace path.", required: false },
              { type: STRING, name: "model", description: "Model id.", required: false },
            ],
          },
          {
            type: SUB,
            name: "resume",
            description: "Resume a thread.",
            options: [{ type: STRING, name: "thread_id", description: "Thread id.", required: true }],
          },
          {
            type: SUB,
            name: "list",
            description: "List threads.",
            options: [
              { type: INTEGER, name: "limit", description: "Maximum threads to return.", required: false },
              { type: BOOLEAN, name: "all", description: "Disable workspace filter.", required: false },
            ],
          },
          { type: SUB, name: "more", description: "Load the next page of threads." },
          {
            type: SUB,
            name: "read",
            description: "Read thread metadata.",
            options: [
              { type: STRING, name: "thread_id", description: "Thread id.", required: false },
              { type: BOOLEAN, name: "turns", description: "Include turns.", required: false },
            ],
          },
          {
            type: SUB,
            name: "fork",
            description: "Fork a thread.",
            options: [
              { type: STRING, name: "thread_id", description: "Thread id.", required: false },
              { type: BOOLEAN, name: "ephemeral", description: "Create an ephemeral fork.", required: false },
            ],
          },
          { type: SUB, name: "loaded", description: "List loaded threads." },
          {
            type: SUB,
            name: "unsubscribe",
            description: "Unsubscribe from a thread.",
            options: [{ type: STRING, name: "thread_id", description: "Thread id.", required: false }],
          },
          {
            type: SUB,
            name: "archive",
            description: "Archive a thread.",
            options: [
              { type: STRING, name: "thread_id", description: "Thread id.", required: false },
              { type: BOOLEAN, name: "confirm", description: "Confirm action.", required: false },
            ],
          },
          {
            type: SUB,
            name: "unarchive",
            description: "Unarchive a thread.",
            options: [{ type: STRING, name: "thread_id", description: "Thread id.", required: false }],
          },
          {
            type: SUB,
            name: "compact",
            description: "Compact a thread.",
            options: [
              { type: STRING, name: "thread_id", description: "Thread id.", required: false },
              { type: BOOLEAN, name: "confirm", description: "Confirm action.", required: false },
            ],
          },
          {
            type: SUB,
            name: "rollback",
            description: "Rollback one or more turns.",
            options: [
              { type: STRING, name: "thread_id", description: "Thread id.", required: false },
              { type: INTEGER, name: "turns", description: "Number of turns.", required: false },
              { type: BOOLEAN, name: "confirm", description: "Confirm action.", required: false },
            ],
          },
        ],
      },
      {
        name: "turn",
        description: "Turn operations.",
        options: [
          {
            type: SUB,
            name: "ask",
            description: "Start a turn.",
            options: [
              { type: STRING, name: "prompt", description: "Prompt text.", required: true },
              { type: STRING, name: "model", description: "Model id.", required: false },
              { type: STRING, name: "effort", description: "Reasoning effort.", required: false },
              { type: STRING, name: "mode", description: "Collaboration mode.", required: false },
              { type: STRING, name: "cwd", description: "Workspace path.", required: false },
            ],
          },
          {
            type: SUB,
            name: "steer",
            description: "Steer the active turn.",
            options: [{ type: STRING, name: "prompt", description: "Steering prompt.", required: true }],
          },
          { type: SUB, name: "interrupt", description: "Interrupt the active turn." },
          {
            type: SUB,
            name: "review",
            description: "Start a review turn.",
            options: [
              { type: STRING, name: "target", description: "uncommitted, base, commit, or custom", required: false },
              { type: STRING, name: "delivery", description: "inline or detached", required: false },
              { type: STRING, name: "branch", description: "Base branch name.", required: false },
              { type: STRING, name: "sha", description: "Commit sha.", required: false },
              { type: STRING, name: "title", description: "Review title.", required: false },
              { type: STRING, name: "instructions", description: "Custom review instructions.", required: false },
            ],
          },
        ],
      },
      {
        name: "model",
        description: "Model controls.",
        options: [
          { type: SUB, name: "show", description: "Show current model profile." },
          { type: SUB, name: "list", description: "List available models." },
          {
            type: SUB,
            name: "set",
            description: "Set the current model.",
            options: [{ type: STRING, name: "value", description: "Model id or default.", required: true }],
          },
          {
            type: SUB,
            name: "effort",
            description: "Show or set reasoning effort.",
            options: [{ type: STRING, name: "value", description: "low, medium, high, xhigh, or default", required: false }],
          },
          {
            type: SUB,
            name: "mode",
            description: "Show, list, or set collaboration mode.",
            options: [{ type: STRING, name: "value", description: "show, list, default, or mode name", required: false }],
          },
        ],
      },
      {
        name: "skills",
        description: "Skill controls.",
        options: [
          { type: SUB, name: "list", description: "List skills." },
          { type: SUB, name: "reload", description: "Reload skills." },
          {
            type: SUB,
            name: "use",
            description: "Run a skill.",
            options: [
              { type: STRING, name: "name", description: "Skill name.", required: true },
              { type: STRING, name: "prompt", description: "Prompt.", required: true },
            ],
          },
          {
            type: SUB,
            name: "enable",
            description: "Enable a skill.",
            options: [{ type: STRING, name: "ref", description: "Skill name or path.", required: true }],
          },
          {
            type: SUB,
            name: "disable",
            description: "Disable a skill.",
            options: [{ type: STRING, name: "ref", description: "Skill name or path.", required: true }],
          },
        ],
      },
      {
        name: "approve",
        description: "Resolve approvals.",
        options: [
          {
            type: SUB,
            name: "resolve",
            description: "Allow or deny a pending approval.",
            options: [
              { type: STRING, name: "request_id", description: "Pending request id.", required: true },
              { type: STRING, name: "decision", description: "allow or deny", required: true },
              { type: STRING, name: "payload", description: "Optional payload.", required: false },
            ],
          },
          {
            type: SUB,
            name: "auto",
            description: "Configure thread auto-approve.",
            options: [
              { type: STRING, name: "action", description: "on, off, or show", required: true },
              { type: STRING, name: "thread_id", description: "Optional thread id.", required: false },
            ],
          },
        ],
      },
      {
        name: "answer",
        description: "Resolve a user-input prompt.",
        options: [
          { type: STRING, name: "request_id", description: "Pending request id.", required: false },
          { type: STRING, name: "payload", description: "Answer payload.", required: false },
          { type: STRING, name: "decision", description: "allow or deny", required: false },
        ],
      },
    ];
  }

  async #resolveChannel(channelId) {
    const id = String(channelId || "").trim();
    if (!id) {
      throw new Error("discord target channel is missing");
    }
    const cached = this.client.channels?.cache?.get?.(id) || null;
    if (cached) {
      return cached;
    }
    if (typeof this.client.channels?.fetch === "function") {
      const fetched = await this.client.channels.fetch(id);
      if (fetched) {
        return fetched;
      }
    }
    throw new Error(`discord channel not found: ${id}`);
  }

  async #handleMessageCreate(message) {
    if (!message || message.author?.bot) {
      return;
    }
    const allowed = this.#isMessageAllowed(message);
    if (!allowed) {
      return;
    }
    const content = String(message.content || "").trim();
    if (!content) {
      return;
    }
    this.emitInbound(this.#messageContext(message, content));
  }

  async #handleInteractionCreate(interaction) {
    if (!interaction) {
      return;
    }

    if (typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand()) {
      const context = this.#interactionContext(interaction, this.#commandTextForInteraction(interaction), "slash");
      if (!context) {
        return;
      }
      if (!await this.#authorizeInteractiveContext(interaction, context)) {
        return;
      }
      this.emitInbound(context);
      return;
    }

    if (typeof interaction.isButton === "function" && interaction.isButton()) {
      await this.#handleComponentInteraction(interaction, "button");
      return;
    }

    if (typeof interaction.isStringSelectMenu === "function" && interaction.isStringSelectMenu()) {
      await this.#handleComponentInteraction(interaction, "select");
    }
  }

  async #authorizeInteractiveContext(interaction, context) {
    if (!this.#isInteractiveChannelAllowed(interaction)) {
      await this.#replyEphemeral(interaction, "This Discord channel is not enabled for the daemon.");
      return false;
    }
    if (typeof this.authorizeInteraction !== "function") {
      return true;
    }
    const allowed = await this.authorizeInteraction(context);
    if (!allowed) {
      await this.#replyEphemeral(interaction, "Unauthorized. Your user ID is not in the binding/channel allowlist.");
      return false;
    }
    return true;
  }

  async #handleComponentInteraction(interaction, interactionKind) {
    const customId = String(interaction.customId || "").trim();
    const match = /^reco:([^:]+):([^:]+)(?::(.+))?$/.exec(customId);
    if (!match) {
      return;
    }
    const [, viewId, controlId, extra = ""] = match;
    const state = this.viewState.get(viewId);
    if (!state || state.expiresAt <= nowMs()) {
      if (state) {
        this.#expireView(viewId);
      }
      await this.#replyEphemeral(interaction, "This control expired. Rerun the command to refresh it.");
      return;
    }

    const baseContext = this.#interactionContext(interaction, "", interactionKind);
    if (!baseContext) {
      await this.#replyEphemeral(interaction, "This control is no longer valid.");
      return;
    }
    if (!await this.#authorizeInteractiveContext(interaction, baseContext)) {
      return;
    }

    if (state.kind === "approval") {
      await this.#handleApprovalInteraction(interaction, baseContext, state, controlId);
      return;
    }
    if (state.kind === "questions") {
      await this.#handleQuestionInteraction(interaction, baseContext, state, controlId, extra);
      return;
    }
    if (state.kind === "cwdBrowser") {
      await this.#handleCwdBrowserInteraction(interaction, baseContext, state, controlId);
      return;
    }
    if (state.kind === "filePicker") {
      await this.#handleFilePickerInteraction(interaction, baseContext, state, controlId);
      return;
    }
    if (state.kind === "commandControls") {
      await this.#handleCommandControlsInteraction(interaction, baseContext, state, controlId);
    }
  }

  async #handleApprovalInteraction(interaction, context, state, controlId) {
    const action = controlId === "allow" ? "allow" : controlId === "deny" ? "deny" : "";
    if (!action) {
      await this.#replyEphemeral(interaction, "Unknown approval action.");
      return;
    }

    state.closed = true;
    const commandText = `/approve ${state.requestId} ${action}`;
    const payload = {
      content: state.content || "",
      embeds: [
        plainEmbed({
          title: "Approval Resolved",
          description: `${state.summary || "Approval request"}\n\nDecision: **${capitalize(action)}**`,
          color: action === "allow" ? 0x57f287 : 0xed4245,
          footer: `Resolved by ${context.userName || context.userId || "unknown user"}`,
        }),
      ],
      components: disableComponents(state.components),
    };
    await interaction.update(payload);
    this.#expireView(state.viewId, { keepDisabled: true });
    this.emitInbound({
      ...context,
      text: commandText,
    });
  }

  async #handleQuestionInteraction(interaction, context, state, controlId, extra) {
    if (controlId === "deny") {
      state.closed = true;
      await interaction.update({
        content: state.content || "",
        embeds: [
          plainEmbed({
            title: "User Input Resolved",
            description: `${state.summary || "User input request"}\n\nDecision: **Denied**`,
            color: 0xed4245,
            footer: `Resolved by ${context.userName || context.userId || "unknown user"}`,
          }),
        ],
        components: disableComponents(state.components),
      });
      this.#expireView(state.viewId, { keepDisabled: true });
      this.emitInbound({
        ...context,
        text: `/answer deny ${state.requestId}`,
      });
      return;
    }

    if (controlId === "submit") {
      const pairs = [];
      for (let index = 0; index < state.questions.length; index += 1) {
        const question = state.questions[index];
        const key = String(question.id || `q${index + 1}`);
        const selected = state.selections[key];
        if (!selected) {
          await this.#replyEphemeral(interaction, `Missing selection for ${key}. Choose an option before submitting.`);
          return;
        }
        pairs.push(`${key}=${selected}`);
      }
      if (!pairs.length) {
        await this.#replyEphemeral(interaction, "This prompt does not have selectable options. Use the text command fallback.");
        return;
      }
      state.closed = true;
      await interaction.update({
        content: state.content || "",
        embeds: [
          plainEmbed({
            title: "User Input Submitted",
            description: `${state.summary || "User input request"}\n\nSelections saved and submitted.`,
            color: 0x57f287,
            footer: `Submitted by ${context.userName || context.userId || "unknown user"}`,
          }),
        ],
        components: disableComponents(state.components),
      });
      this.#expireView(state.viewId, { keepDisabled: true });
      this.emitInbound({
        ...context,
        text: `/answer ${state.requestId} ${pairs.join(";")}`,
      });
      return;
    }

    if (!controlId.startsWith("q")) {
      await this.#replyEphemeral(interaction, "Unknown question control.");
      return;
    }
    const question = state.questionByControlId[controlId];
    if (!question) {
      await this.#replyEphemeral(interaction, "Unknown question control.");
      return;
    }
    const valueKey = String(interaction.values?.[0] || "");
    const optionValue = question.valueMap[valueKey];
    if (!optionValue) {
      await this.#replyEphemeral(interaction, "Unknown option.");
      return;
    }
    state.selections[question.key] = optionValue;
    await interaction.deferUpdate();
  }

  async #handleCommandControlsInteraction(interaction, context, state, controlId) {
    const buttonCommand = state.buttons?.[controlId] || "";
    if (buttonCommand) {
      await interaction.deferUpdate();
      this.emitInbound({
        ...context,
        text: buttonCommand,
      });
      return;
    }

    const selectState = state.selects?.[controlId] || null;
    if (!selectState) {
      await this.#replyEphemeral(interaction, "Unknown control.");
      return;
    }
    const selectedValue = String(interaction.values?.[0] || "");
    const commandText = selectState.values?.[selectedValue] || "";
    if (!commandText) {
      await this.#replyEphemeral(interaction, "Unknown option.");
      return;
    }
    await interaction.deferUpdate();
    this.emitInbound({
      ...context,
      text: commandText,
    });
  }

  async #handleCwdBrowserInteraction(interaction, context, state, controlId) {
    if (controlId === "cancel") {
      state.closed = true;
      const embed = plainEmbed({
        title: "Workspace Browse Cancelled",
        description: state.selectedPath
          ? `No workspace change applied.\nSelected: ${state.selectedPath}`
          : "No workspace change applied.",
        color: 0xed4245,
        footer: `Closed by ${context.userName || context.userId || "unknown user"}`,
      });
      state.embeds = [embed];
      await interaction.update({
        content: state.content || "",
        embeds: [embed],
        components: disableComponents(state.components),
      });
      this.#expireView(state.viewId, { keepDisabled: true });
      return;
    }

    if (controlId === "confirm") {
      if (!state.selectedPath) {
        await this.#replyEphemeral(interaction, "Choose a subdirectory before confirming.");
        return;
      }
      state.closed = true;
      const embed = plainEmbed({
        title: "Workspace Change Submitted",
        description: `Jumping to:\n${state.selectedPath}`,
        color: 0x57f287,
        footer: `Submitted by ${context.userName || context.userId || "unknown user"}`,
      });
      state.embeds = [embed];
      await interaction.update({
        content: state.content || "",
        embeds: [embed],
        components: disableComponents(state.components),
      });
      this.#expireView(state.viewId, { keepDisabled: true });
      this.emitInbound({
        ...context,
        text: `/cwd ${state.selectedPath}`,
      });
      return;
    }

    if (controlId !== "pick") {
      await this.#replyEphemeral(interaction, "Unknown control.");
      return;
    }

    const valueKey = String(interaction.values?.[0] || "");
    const selectedPath = state.valueMap?.[valueKey];
    if (!selectedPath) {
      await this.#replyEphemeral(interaction, "Unknown option.");
      return;
    }
    state.selectedPath = selectedPath;
    const view = this.#buildCwdBrowserView(state);
    state.embeds = [view.embed];
    state.components = view.components;
    state.valueMap = view.valueMap;
    await interaction.update({
      content: state.content || "",
      embeds: [view.embed],
      components: view.components,
    });
  }

  async #handleFilePickerInteraction(interaction, context, state, controlId) {
    if (controlId === "cancel") {
      state.closed = true;
      const embed = plainEmbed({
        title: "File Picker Closed",
        description: state.selectedPath
          ? `No action applied.\nSelected: ${state.selectedPath}`
          : "No action applied.",
        color: 0xed4245,
        footer: `Closed by ${context.userName || context.userId || "unknown user"}`,
      });
      state.embeds = [embed];
      await interaction.update({
        content: state.content || "",
        embeds: [embed],
        components: disableComponents(state.components),
      });
      this.#expireView(state.viewId, { keepDisabled: true });
      return;
    }

    if (controlId === "preview") {
      if (!state.selectedPath) {
        await this.#replyEphemeral(interaction, "Choose a file before previewing.");
        return;
      }
      await interaction.deferUpdate();
      const commandText = state.mode === "search"
        ? `/search --preview64 ${encodeCommandValue(state.selectedPath)} --root64 ${encodeCommandValue(state.rootDir)} --query64 ${encodeCommandValue(state.query || "")}`
        : `/files --preview64 ${encodeCommandValue(state.selectedPath)} --dir64 ${encodeCommandValue(state.currentDir)} --root64 ${encodeCommandValue(state.rootDir)}`;
      this.emitInbound({
        ...context,
        text: commandText,
      });
      return;
    }

    if (controlId === "up") {
      if (!state.canGoUp) {
        await this.#replyEphemeral(interaction, "Already at the workspace root.");
        return;
      }
      const nextDir = state.parentDir || state.rootDir;
      this.emitInbound({
        ...context,
        text: `/files --dir64 ${encodeCommandValue(nextDir)} --root64 ${encodeCommandValue(state.rootDir)}`,
      });
      return;
    }

    if (controlId !== "pick") {
      await this.#replyEphemeral(interaction, "Unknown control.");
      return;
    }

    const valueKey = String(interaction.values?.[0] || "");
    const selectedEntry = state.valueMap?.[valueKey] || null;
    if (!selectedEntry) {
      await this.#replyEphemeral(interaction, "Unknown option.");
      return;
    }
    if (selectedEntry.entryType === "dir" && state.mode === "browser") {
      this.emitInbound({
        ...context,
        text: `/files --dir64 ${encodeCommandValue(selectedEntry.path)} --root64 ${encodeCommandValue(state.rootDir)}`,
      });
      return;
    }
    if (selectedEntry.entryType !== "file") {
      await this.#replyEphemeral(interaction, "Preview is only available for files.");
      return;
    }
    state.selectedPath = selectedEntry.path;
    const view = this.#buildFilePickerView(state);
    state.embeds = [view.embed];
    state.components = view.components;
    state.valueMap = view.valueMap;
    await interaction.update({
      content: state.content || "",
      embeds: [view.embed],
      components: view.components,
    });
  }

  #messageContext(message, text) {
    const channel = message.channel;
    const threadId = isThreadChannel(channel) ? String(channel.id || "") : String(channel.id || "");
    return {
      channel: "discord",
      chatId: String(channel.id || ""),
      userId: String(message.author?.id || ""),
      userName: message.author?.username || message.author?.displayName || "",
      text: String(text || ""),
      messageId: String(message.id || ""),
      replyToMessageId: String(message.reference?.messageId || message.reference?.message_id || ""),
      threadId: threadId || String(channel.id || ""),
      raw: message,
      discordMeta: {
        kind: "message",
        responded: true,
      },
    };
  }

  #interactionContext(interaction, text, kind) {
    const channel = interaction.channel;
    if (!channel) {
      return null;
    }
    const threadId = isThreadChannel(channel) ? String(channel.id || interaction.channelId || "") : String(interaction.channelId || channel.id || "");
    return {
      channel: "discord",
      chatId: String(interaction.channelId || channel.id || ""),
      userId: String(interaction.user?.id || ""),
      userName: interaction.user?.username || interaction.user?.displayName || "",
      text: String(text || ""),
      messageId: String(interaction.message?.id || ""),
      replyToMessageId: String(interaction.message?.reference?.messageId || interaction.message?.reference?.message_id || ""),
      threadId: threadId || String(interaction.channelId || channel.id || ""),
      raw: interaction,
      discordMeta: {
        kind,
        interactionId: String(interaction.id || ""),
        responded: Boolean(interaction.replied || interaction.responded),
      },
    };
  }

  #isMessageAllowed(message) {
    if (!message?.channel) {
      return false;
    }
    if (message.channel.isDMBased?.() || message.guild == null) {
      return this.allowedUserIds.includes(String(message.author?.id || ""));
    }
    if (this.allowedChannels.includes(String(message.channel.id || ""))) {
      return true;
    }
    return this.allowedChannels.includes(String(message.channel.parentId || message.channel.parent?.id || ""));
  }

  #isInteractiveChannelAllowed(interaction) {
    const channel = interaction?.channel;
    if (!channel) {
      return false;
    }
    if (channel.isDMBased?.() || interaction.guild == null) {
      return this.allowedUserIds.includes(String(interaction.user?.id || ""));
    }
    if (this.allowedChannels.includes(String(channel.id || interaction.channelId || ""))) {
      return true;
    }
    return this.allowedChannels.includes(String(channel.parentId || channel.parent?.id || ""));
  }

  async #replyEphemeral(interaction, content) {
    const payload = { content, ephemeral: true };
    if (interaction.deferred && !interaction.replied && typeof interaction.editReply === "function") {
      await interaction.editReply(payload);
      return;
    }
    if (!interaction.replied && typeof interaction.reply === "function") {
      await interaction.reply(payload);
      return;
    }
    if (typeof interaction.followUp === "function") {
      await interaction.followUp(payload);
    }
  }

  #renderNativeUi(nativeUi, { fallbackText = "" } = {}) {
    if (nativeUi.kind === "approvalPrompt") {
      return this.#renderApprovalUi(nativeUi, { fallbackText });
    }
    if (nativeUi.kind === "questionPrompt") {
      return this.#renderQuestionUi(nativeUi, { fallbackText });
    }
    if (nativeUi.kind === "cwdBrowser") {
      return this.#renderCwdBrowserUi(nativeUi, { fallbackText });
    }
    if (nativeUi.kind === "filePicker") {
      return this.#renderFilePickerUi(nativeUi, { fallbackText });
    }
    if (nativeUi.kind === "threadList" || nativeUi.kind === "modelPicker") {
      return this.#renderCommandControlsUi(nativeUi, { fallbackText });
    }
    return this.#renderCommandControlsUi(nativeUi, { fallbackText });
  }

  #renderApprovalUi(nativeUi, { fallbackText = "" } = {}) {
    const viewId = shortId();
    const components = [
      row([
        button({ customId: `reco:${viewId}:allow`, label: "Allow", style: 3 }),
        button({ customId: `reco:${viewId}:deny`, label: "Deny", style: 4 }),
      ]),
    ];
    const embed = plainEmbed({
      title: "Approval Required",
      description: nativeUi.summary || fallbackText || "Approval required.",
      color: 0xfaa61a,
    });
    return {
      embed,
      components,
      state: {
        kind: "approval",
        viewId,
        requestId: String(nativeUi.requestId || "").trim(),
        summary: nativeUi.summary || "Approval required",
        content: fallbackText,
        embeds: [embed],
        components,
        expiresAt: nowMs() + VIEW_TTL_MS,
      },
    };
  }

  #renderQuestionUi(nativeUi, { fallbackText = "" } = {}) {
    const questions = Array.isArray(nativeUi.questions) ? nativeUi.questions : [];
    const viewId = shortId();
    const questionStates = [];
    const components = [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const labels = (Array.isArray(question.options) ? question.options : [])
        .map((option) => stringifyOptionLabel(option))
        .filter(Boolean)
        .slice(0, 25);
      if (!labels.length) {
        return this.#renderApprovalUi({
          kind: "approvalPrompt",
          requestId: nativeUi.requestId,
          summary: nativeUi.summary || fallbackText || "User input required.",
        }, { fallbackText });
      }
      const controlId = `q${index + 1}`;
      const key = String(question.id || controlId).trim();
      const valueMap = {};
      const options = labels.map((label, optionIndex) => {
        const valueKey = `o${optionIndex}`;
        valueMap[valueKey] = label;
        return selectOption({
          label,
          value: valueKey,
          description: key === controlId ? question.question || "" : key,
        });
      });
      questionStates.push({ controlId, key, valueMap });
      components.push(row([
        stringSelect({
          customId: `reco:${viewId}:${controlId}`,
          placeholder: `${key}: ${String(question.question || "").slice(0, 80)}`,
          options,
        }),
      ]));
    }
    components.push(row([
      button({ customId: `reco:${viewId}:submit`, label: "Submit", style: 3 }),
      button({ customId: `reco:${viewId}:deny`, label: "Deny", style: 4 }),
    ]));
    const embed = plainEmbed({
      title: "User Input Required",
      description: nativeUi.summary || fallbackText || "User input required.",
      color: 0x5865f2,
    });
    const questionByControlId = {};
    for (const state of questionStates) {
      questionByControlId[state.controlId] = state;
    }
    return {
      embed,
      components,
      state: {
        kind: "questions",
        viewId,
        requestId: String(nativeUi.requestId || "").trim(),
        summary: nativeUi.summary || "User input required",
        content: fallbackText,
        embeds: [embed],
        components,
        questions: questions.map((entry, index) => ({
          id: String(entry.id || "").trim() || `q${index + 1}`,
          question: String(entry.question || "").trim(),
        })),
        questionByControlId,
        selections: {},
        expiresAt: nowMs() + VIEW_TTL_MS,
      },
    };
  }

  #buildCwdBrowserView({
    viewId,
    title = "Browse Workspace",
    description = "",
    entries = [],
    selectedPath = "",
  } = {}) {
    const valueMap = {};
    const components = [];
    if (entries.length) {
      const options = entries.slice(0, 25).map((entry, index) => {
        const valueKey = `o${index}`;
        valueMap[valueKey] = entry.path;
        return selectOption({
          label: entry.label,
          value: valueKey,
          description: entry.description || "",
          defaultValue: entry.path === selectedPath,
        });
      });
      components.push(row([
        stringSelect({
          customId: `reco:${viewId}:pick`,
          placeholder: "Select a subdirectory",
          options,
        }),
      ]));
    }
    components.push(row([
      button({
        customId: `reco:${viewId}:confirm`,
        label: "Confirm",
        style: 3,
        disabled: !selectedPath,
      }),
      button({
        customId: `reco:${viewId}:cancel`,
        label: "Cancel",
        style: 4,
      }),
    ]));
    const embed = plainEmbed({
      title,
      description: [
        description || "Choose a subdirectory, then confirm to jump there.",
        selectedPath ? `Selected: ${selectedPath}` : "",
      ].filter(Boolean).join("\n"),
      color: 0x3ba55d,
    });
    return {
      embed,
      components,
      valueMap,
    };
  }

  #renderCwdBrowserUi(nativeUi, { fallbackText = "" } = {}) {
    const viewId = shortId();
    const entries = ((Array.isArray(nativeUi.components?.selects) ? nativeUi.components.selects[0]?.options : []) || [])
      .map((entry) => ({
        label: String(entry?.label || "").slice(0, 100),
        description: String(entry?.description || "").slice(0, 100),
        path: String(entry?.path || "").trim(),
      }))
      .filter((entry) => entry.label && entry.path)
      .slice(0, 25);
    const title = nativeUi.title || "Browse Workspace";
    const description = nativeUi.description || fallbackText || "Choose a subdirectory, then confirm to jump there.";
    const built = this.#buildCwdBrowserView({
      viewId,
      title,
      description,
      entries,
      selectedPath: "",
    });
    return {
      embed: built.embed,
      components: built.components,
      state: {
        kind: "cwdBrowser",
        viewId,
        title,
        description,
        entries,
        selectedPath: "",
        valueMap: built.valueMap,
        content: fallbackText,
        embeds: [built.embed],
        components: built.components,
        expiresAt: nowMs() + VIEW_TTL_MS,
      },
    };
  }

  #buildFilePickerView({
    viewId,
    title = "Browse Files",
    description = "",
    mode = "browser",
    rootDir = "",
    currentDir = "",
    query = "",
    entries = [],
    selectedPath = "",
    canGoUp = false,
  } = {}) {
    const valueMap = {};
    const components = [];
    if (entries.length) {
      const options = entries.slice(0, 25).map((entry, index) => {
        const valueKey = `o${index}`;
        valueMap[valueKey] = {
          path: entry.path,
          entryType: entry.entryType,
        };
        return selectOption({
          label: entry.label,
          value: valueKey,
          description: entry.description || "",
          defaultValue: entry.path === selectedPath,
        });
      });
      components.push(row([
        stringSelect({
          customId: `reco:${viewId}:pick`,
          placeholder: mode === "search" ? "Select a file result" : "Select a directory or file",
          options,
        }),
      ]));
    }
    const buttonRow = [];
    if (mode === "browser") {
      buttonRow.push(button({
        customId: `reco:${viewId}:up`,
        label: "Up",
        style: 1,
        disabled: !canGoUp,
      }));
    }
    buttonRow.push(button({
      customId: `reco:${viewId}:preview`,
      label: "Preview",
      style: 3,
      disabled: !selectedPath,
    }));
    buttonRow.push(button({
      customId: `reco:${viewId}:cancel`,
      label: "Cancel",
      style: 4,
    }));
    components.push(row(buttonRow));

    const embed = plainEmbed({
      title,
      description: [
        description,
        mode === "search" ? `Query: ${query || "(empty)"}` : `Current directory: ${currentDir || rootDir || "unknown"}`,
        selectedPath ? `Selected file: ${selectedPath}` : "",
      ].filter(Boolean).join("\n"),
      color: 0x3ba55d,
    });
    return {
      embed,
      components,
      valueMap,
    };
  }

  #renderFilePickerUi(nativeUi, { fallbackText = "" } = {}) {
    const viewId = shortId();
    const mode = nativeUi.mode === "search" ? "search" : "browser";
    const entries = ((Array.isArray(nativeUi.components?.selects) ? nativeUi.components.selects[0]?.options : []) || [])
      .map((entry) => ({
        label: String(entry?.label || "").slice(0, 100),
        description: String(entry?.description || "").slice(0, 100),
        path: String(entry?.path || "").trim(),
        entryType: String(entry?.entryType || "file"),
      }))
      .filter((entry) => entry.label && entry.path)
      .slice(0, 25);
    const state = {
      kind: "filePicker",
      viewId,
      title: nativeUi.title || (mode === "search" ? "Search Files" : "Browse Files"),
      description: nativeUi.description || fallbackText || "Select a directory or file.",
      mode,
      rootDir: String(nativeUi.rootDir || "").trim(),
      currentDir: String(nativeUi.currentDir || "").trim(),
      query: String(nativeUi.query || "").trim(),
      entries,
      selectedPath: "",
      canGoUp: Boolean(nativeUi.canGoUp),
      parentDir: String(nativeUi.parentDir || "").trim(),
      content: fallbackText,
      expiresAt: nowMs() + VIEW_TTL_MS,
    };
    const built = this.#buildFilePickerView(state);
    return {
      embed: built.embed,
      components: built.components,
      state: {
        ...state,
        valueMap: built.valueMap,
        embeds: [built.embed],
        components: built.components,
      },
    };
  }

  #renderCommandControlsUi(nativeUi, { fallbackText = "" } = {}) {
    const viewId = shortId();
    const embed = plainEmbed({
      title: nativeUi.title || firstLine(fallbackText) || "Discord Controls",
      description: nativeUi.description || fallbackText || "Select an action below.",
      color: nativeUi.kind === "threadList" ? 0x5865f2 : 0x3ba55d,
    });
    const buttonsMap = {};
    const selectsMap = {};
    const components = [];

    const buttons = Array.isArray(nativeUi.components?.buttons) ? nativeUi.components.buttons : [];
    const rows = [];
    for (let index = 0; index < buttons.length; index += 5) {
      const group = buttons.slice(index, index + 5).map((entry, buttonIndex) => {
        const controlId = `b${index + buttonIndex}`;
        buttonsMap[controlId] = String(entry.commandText || "").trim();
        return button({
          customId: `reco:${viewId}:${controlId}`,
          label: entry.label,
          style: entry.style || 2,
          disabled: Boolean(entry.disabled),
        });
      });
      if (group.length) {
        rows.push(row(group));
      }
    }

    const selects = Array.isArray(nativeUi.components?.selects) ? nativeUi.components.selects : [];
    for (let index = 0; index < selects.length; index += 1) {
      const entry = selects[index];
      const controlId = `s${index}`;
      const values = {};
      const options = (Array.isArray(entry.options) ? entry.options : []).slice(0, 25).map((option, optionIndex) => {
        const valueKey = `o${optionIndex}`;
        values[valueKey] = String(option.commandText || "").trim();
        return selectOption({
          label: option.label,
          value: valueKey,
          description: option.description || "",
          defaultValue: Boolean(option.defaultValue),
        });
      });
      selectsMap[controlId] = { values };
      rows.push(row([
        stringSelect({
          customId: `reco:${viewId}:${controlId}`,
          placeholder: entry.placeholder || "Choose an option",
          options,
        }),
      ]));
    }

    components.push(...rows.slice(0, 5));

    return {
      embed,
      components,
      state: {
        kind: "commandControls",
        viewId,
        buttons: buttonsMap,
        selects: selectsMap,
        embeds: [embed],
        components,
        content: fallbackText,
        expiresAt: nowMs() + VIEW_TTL_MS,
      },
    };
  }

  #buildApprovalPromptPayload(_context, approvalRequest) {
    const summaryText = [
      `Approval required (${approvalRequest.kind})`,
      approvalRequest.summary ? `details: ${approvalRequest.summary}` : "",
      "Use the buttons below, or fall back to typed /approve if needed.",
    ].filter(Boolean).join("\n");
    return {
      text: summaryText,
      nativeUi: {
        kind: "approvalPrompt",
        requestId: String(approvalRequest.localRequestId || "").trim(),
        summary: approvalRequest.summary || `Approval required (${approvalRequest.kind})`,
      },
    };
  }

  #buildQuestionPromptPayload(_context, approvalRequest) {
    const questions = Array.isArray(approvalRequest.questions) ? approvalRequest.questions : [];
    if (!questions.length || questions.length > 4) {
      return null;
    }
    for (const question of questions) {
      const labels = (Array.isArray(question?.options) ? question.options : [])
        .map((option) => stringifyOptionLabel(option))
        .filter(Boolean)
        .slice(0, 25);
      if (!labels.length) {
        return null;
      }
    }

    const summaryText = [
      `User input required (${approvalRequest.kind})`,
      approvalRequest.summary ? `details: ${approvalRequest.summary}` : "",
      "Use the dropdowns below, then submit. Typed /answer remains available as fallback.",
    ].filter(Boolean).join("\n");

    return {
      text: summaryText,
      nativeUi: {
        kind: "questionPrompt",
        requestId: String(approvalRequest.localRequestId || "").trim(),
        summary: approvalRequest.summary || "tool input required",
        questions,
      },
    };
  }

  #finalizeViewRegistration(nativeUiState, messageRef) {
    const state = nativeUiState?.state || nativeUiState;
    if (!state?.viewId) {
      return;
    }
    state.messageId = messageRef.messageId || "";
    state.chatId = messageRef.chatId || messageRef.channelId || "";
    state.timer = setTimeout(() => {
      this.#disableExpiredView(state.viewId).catch((error) => {
        this.logger.warn(`[discord] failed to disable expired view ${state.viewId}: ${error.message}`);
      });
    }, Math.max(1000, state.expiresAt - nowMs()));
    this.viewState.set(state.viewId, state);
  }

  async #disableExpiredView(viewId) {
    const state = this.viewState.get(viewId);
    if (!state) {
      return;
    }
    const disabled = disableComponents(state.components);
    if (state.chatId && state.messageId) {
      try {
        const channel = await this.#resolveChannel(state.chatId);
        const message = await channel.messages.fetch(state.messageId);
        await message.edit({
          ...(state.content ? { content: state.content } : {}),
          ...(state.embeds?.length ? { embeds: state.embeds } : {}),
          components: disabled,
        });
      } catch {
        // ignore best-effort expiry edits
      }
    }
    state.components = disabled;
    this.#expireView(viewId, { keepDisabled: true });
  }

  #expireView(viewId, { keepDisabled = false } = {}) {
    const state = this.viewState.get(viewId);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
    }
    this.viewState.delete(viewId);
    if (!keepDisabled) {
      state.expired = true;
    }
  }

  #commandTextForInteraction(interaction) {
    const options = interaction.options;
    const command = String(interaction.commandName || "").trim();
    if (!command) {
      return "";
    }

    if (command === "new") {
      return "/new";
    }
    if (command === "resume") {
      return `/resume ${String(options?.getString?.("thread_id") || "").trim()}`.trim();
    }
    if (command === "status") {
      return "/status";
    }
    if (command === "archive") {
      const threadId = String(options?.getString?.("thread_id") || "").trim();
      return threadId ? `/archive ${threadId}` : "/archive";
    }
    if (command === "cwd") {
      return `/cwd ${String(options?.getString?.("path") || "").trim()}`.trim();
    }
    if (command === "files") {
      return "/files";
    }
    if (command === "search") {
      return `/search ${String(options?.getString?.("query") || "").trim()}`.trim();
    }
    if (command === "help") {
      const topic = String(options?.getString?.("topic") || "").trim();
      return topic ? `/help ${topic}` : "/help";
    }
    if (command === "interrupt") {
      return "/interrupt";
    }
    if (command === "plan") {
      const action = String(options?.getString?.("action") || "").trim();
      return action ? `/plan ${action}` : "/plan";
    }
    if (command === "autopilot") {
      const subcommand = options?.getSubcommand?.(false) || "";
      if (subcommand === "continue") {
        return `/autopilot continue ${String(options?.getString?.("value") || "").trim()}`.trim();
      }
      if (subcommand === "mode") {
        return `/autopilot mode ${String(options?.getString?.("value") || "").trim()}`.trim();
      }
      return `/autopilot ${subcommand || "status"}`.trim();
    }
    if (command === "thread") {
      const subcommand = options?.getSubcommand?.(false) || "";
      const parts = ["/thread", subcommand];
      if (subcommand === "start") {
        const cwd = String(options?.getString?.("cwd") || "").trim();
        const model = String(options?.getString?.("model") || "").trim();
        if (cwd) {
          parts.push("--cwd", cwd);
        }
        if (model) {
          parts.push("--model", model);
        }
      } else if (subcommand === "list") {
        if (options?.getBoolean?.("all")) {
          parts.push("all");
        }
        const limit = options?.getInteger?.("limit");
        if (Number.isFinite(limit)) {
          parts.push(String(limit));
        }
      } else if (["resume", "read", "fork", "unsubscribe", "archive", "unarchive", "compact", "rollback"].includes(subcommand)) {
        const threadId = String(options?.getString?.("thread_id") || "").trim();
        if (threadId) {
          parts.push(threadId);
        }
        const turns = options?.getInteger?.("turns");
        if (Number.isFinite(turns)) {
          parts.push("--turns", String(turns));
        }
        if (options?.getBoolean?.("ephemeral")) {
          parts.push("--ephemeral", "true");
        }
        if (options?.getBoolean?.("confirm")) {
          parts.push("--confirm");
        }
      }
      return parts.filter(Boolean).join(" ").trim();
    }
    if (command === "turn") {
      const subcommand = options?.getSubcommand?.(false) || "";
      const parts = ["/turn", subcommand];
      if (subcommand === "ask") {
        parts.push(String(options?.getString?.("prompt") || "").trim());
        for (const key of ["model", "effort", "mode", "cwd"]) {
          const value = String(options?.getString?.(key) || "").trim();
          if (value) {
            parts.push(`--${key}`, value);
          }
        }
      } else if (subcommand === "steer") {
        parts.push(String(options?.getString?.("prompt") || "").trim());
      } else if (subcommand === "review") {
        const target = String(options?.getString?.("target") || "").trim();
        const delivery = String(options?.getString?.("delivery") || "").trim();
        const branch = String(options?.getString?.("branch") || "").trim();
        const sha = String(options?.getString?.("sha") || "").trim();
        const title = String(options?.getString?.("title") || "").trim();
        const instructions = String(options?.getString?.("instructions") || "").trim();
        if (target) {
          parts.push(target);
        }
        if (delivery) {
          parts.push("--delivery", delivery);
        }
        if (branch) {
          parts.push("--branch", branch);
        }
        if (sha) {
          parts.push("--sha", sha);
        }
        if (title) {
          parts.push("--title", title);
        }
        if (instructions) {
          parts.push("--instructions", instructions);
        }
      }
      return parts.filter(Boolean).join(" ").trim();
    }
    if (command === "model") {
      const subcommand = options?.getSubcommand?.(false) || "";
      if (subcommand === "show" || subcommand === "list") {
        return `/model ${subcommand}`;
      }
      if (subcommand === "set") {
        return `/model set ${String(options?.getString?.("value") || "").trim()}`.trim();
      }
      if (subcommand === "effort") {
        const value = String(options?.getString?.("value") || "").trim();
        return value ? `/model effort set ${value}` : "/model effort show";
      }
      if (subcommand === "mode") {
        const value = String(options?.getString?.("value") || "").trim();
        if (!value || value === "show") {
          return "/model mode show";
        }
        if (value === "list") {
          return "/model mode list";
        }
        return `/model mode set ${value}`.trim();
      }
    }
    if (command === "skills") {
      const subcommand = options?.getSubcommand?.(false) || "";
      if (subcommand === "list" || subcommand === "reload") {
        return `/skills ${subcommand}`;
      }
      if (subcommand === "use") {
        return `/skills use ${String(options?.getString?.("name") || "").trim()} ${String(options?.getString?.("prompt") || "").trim()}`.trim();
      }
      if (subcommand === "enable" || subcommand === "disable") {
        return `/skills ${subcommand} ${String(options?.getString?.("ref") || "").trim()}`.trim();
      }
    }
    if (command === "approve") {
      const subcommand = options?.getSubcommand?.(false) || "";
      if (subcommand === "resolve") {
        const requestId = String(options?.getString?.("request_id") || "").trim();
        const decision = String(options?.getString?.("decision") || "").trim();
        const payload = String(options?.getString?.("payload") || "").trim();
        return ["/approve", requestId, decision, payload].filter(Boolean).join(" ").trim();
      }
      if (subcommand === "auto") {
        const action = String(options?.getString?.("action") || "").trim();
        const threadId = String(options?.getString?.("thread_id") || "").trim();
        return ["/approve", "auto", action, threadId].filter(Boolean).join(" ").trim();
      }
    }
    if (command === "answer") {
      const requestId = String(options?.getString?.("request_id") || "").trim();
      const payload = String(options?.getString?.("payload") || "").trim();
      const decision = String(options?.getString?.("decision") || "").trim().toLowerCase();
      if (decision === "deny") {
        return ["/answer", "deny", requestId].filter(Boolean).join(" ").trim();
      }
      return ["/answer", requestId, payload].filter(Boolean).join(" ").trim() || "/answer";
    }
    return `/${command}`;
  }
}
