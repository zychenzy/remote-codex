import { BaseAdapter } from "./base-adapter.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RATE_LIMIT_RETRIES = 3;
const DISCORD_MAX_CONTENT = 1900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamKey(context) {
  return `${context.channel || "discord"}:${String(context.chatId || "")}:${String(context.turnId || "active")}`;
}

function formatDiscordContent(text, { live = false } = {}) {
  const raw = String(text || "");
  if (!raw) {
    return live ? "…" : "";
  }
  if (raw.length <= DISCORD_MAX_CONTENT) {
    return raw;
  }
  const suffix = live ? "\n...[live view truncated]" : "\n...[truncated]";
  const keep = Math.max(0, DISCORD_MAX_CONTENT - suffix.length);
  return `${raw.slice(0, keep)}${suffix}`;
}

export class DiscordAdapter extends BaseAdapter {
  constructor({
    token,
    allowedChannels = [],
    pollIntervalMs = 1800,
    minSendIntervalMs = 450,
    streamEditIntervalMs = 1500,
    logger = console,
  } = {}) {
    super({ channel: "discord", logger });
    this.token = token;
    this.allowedChannels = allowedChannels;
    this.pollIntervalMs = pollIntervalMs;
    this.minSendIntervalMs = minSendIntervalMs;
    this.streamEditIntervalMs = streamEditIntervalMs;
    this.running = false;
    this.loopTimer = null;
    this.lastSeenByChannel = new Map();
    this.invalidChannels = new Set();
    this.sendQueue = Promise.resolve();
    this.nextAllowedSendAt = 0;
    this.streamMessages = new Map();
  }

  async start() {
    if (!this.token) {
      this.logger.warn("[discord] token missing; adapter disabled");
      return;
    }

    if (!Array.isArray(this.allowedChannels) || this.allowedChannels.length === 0) {
      this.logger.warn("[discord] no allowed channels configured; adapter idle");
      return;
    }

    this.running = true;
    await this.#pollLoop();
  }

  async stop() {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const state of this.streamMessages.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.streamMessages.clear();
  }

  async sendMessage(context, text) {
    const content = formatDiscordContent(text, { live: false });
    await this.#enqueueSend(async () => {
      await this.#api(`/channels/${context.chatId}/messages`, {
        method: "POST",
        body: {
          content,
        },
      });
    });
  }

  async sendStreamingDelta(context, textDelta) {
    const key = streamKey(context);
    const state = this.streamMessages.get(key) || {
      chatId: String(context.chatId || ""),
      messageId: "",
      content: "",
      timer: null,
      dirty: false,
      flushing: false,
      pending: false,
    };

    state.chatId = String(context.chatId || state.chatId || "");
    state.content += String(textDelta || "");
    state.dirty = true;

    if (state.flushing) {
      state.pending = true;
      this.streamMessages.set(key, state);
      return;
    }

    if (!state.timer) {
      state.timer = setTimeout(() => {
        this.#flushStreamMessage(key).catch((error) => {
          this.logger.error(`[discord] stream flush failed: ${error.message}`);
        });
      }, this.streamEditIntervalMs);
    }
    this.streamMessages.set(key, state);
  }

  async flushStreamingMessage(context, { finalText = null } = {}) {
    const key = streamKey(context);
    const state = this.streamMessages.get(key) || {
      chatId: String(context.chatId || ""),
      messageId: "",
      content: "",
      timer: null,
      dirty: false,
      flushing: false,
      pending: false,
    };

    state.chatId = String(context.chatId || state.chatId || "");
    if (typeof finalText === "string") {
      state.content = finalText;
    }
    state.dirty = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.streamMessages.set(key, state);

    await this.#flushStreamMessage(key, { force: true });
    this.streamMessages.delete(key);
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

  async #flushStreamMessage(key, { force = false } = {}) {
    const state = this.streamMessages.get(key);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (state.flushing) {
      state.pending = true;
      this.streamMessages.set(key, state);
      return;
    }

    state.flushing = true;
    this.streamMessages.set(key, state);
    try {
      do {
        state.pending = false;
        if (!force && !state.dirty) {
          break;
        }

        const content = formatDiscordContent(state.content, { live: true });
        state.dirty = false;

        await this.#enqueueSend(async () => {
          if (!state.messageId) {
            const created = await this.#api(`/channels/${state.chatId}/messages`, {
              method: "POST",
              body: { content },
            });
            state.messageId = String(created?.id || "");
          } else {
            await this.#api(`/channels/${state.chatId}/messages/${state.messageId}`, {
              method: "PATCH",
              body: { content },
            });
          }
        });

        force = false;
      } while (state.pending || state.dirty);
    } finally {
      state.flushing = false;
      this.streamMessages.set(key, state);
    }
  }

  async #pollLoop() {
    if (!this.running) {
      return;
    }

    for (const channelId of this.allowedChannels) {
      if (this.invalidChannels.has(channelId)) {
        continue;
      }

      try {
        const messages = await this.#api(`/channels/${channelId}/messages?limit=10`);
        const newestFirst = Array.isArray(messages) ? messages : [];
        const chronological = [...newestFirst].reverse();

        for (const msg of chronological) {
          const id = String(msg.id || "");
          const lastSeen = this.lastSeenByChannel.get(channelId);
          if (lastSeen && BigInt(id) <= BigInt(lastSeen)) {
            continue;
          }

          this.lastSeenByChannel.set(channelId, id);

          if (msg.author?.bot) {
            continue;
          }

          const content = String(msg.content || "").trim();
          if (!content) {
            continue;
          }

          this.emitInbound({
            channel: "discord",
            chatId: String(channelId),
            userId: String(msg.author?.id || ""),
            userName: msg.author?.username || "",
            text: content,
            raw: msg,
          });
        }
      } catch (error) {
        if (isUnknownChannelError(error)) {
          this.invalidChannels.add(channelId);
          this.logger.error(
            `[discord] channel ${channelId} is invalid/inaccessible (code 10003). ` +
            "Use the actual text-channel ID and restart daemon after updating config."
          );
          continue;
        }
        this.logger.error(`[discord] polling error for channel ${channelId}: ${error.message}`);
      }
    }

    this.loopTimer = setTimeout(() => {
      this.#pollLoop().catch((err) => this.logger.error(`[discord] loop failed: ${err.message}`));
    }, this.pollIntervalMs);
  }

  async #api(path, { method = "GET", body = null } = {}) {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await fetch(`${DISCORD_API}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status === 429) {
        const text = await response.text();
        let retryAfterMs = 400;
        try {
          const payload = JSON.parse(text);
          const seconds = Number(payload?.retry_after);
          if (Number.isFinite(seconds) && seconds > 0) {
            retryAfterMs = Math.ceil(seconds * 1000) + 50;
          }
        } catch {
          // keep default
        }
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          this.logger.warn(`[discord] rate limited on ${path}; retrying in ${retryAfterMs}ms`);
          await sleep(retryAfterMs);
          continue;
        }
        throw new Error(`discord ${path} failed: 429 ${text}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`discord ${path} failed: ${response.status} ${text}`);
      }

      if (response.status === 204) {
        return null;
      }

      return response.json();
    }
    throw new Error(`discord ${path} failed after retries`);
  }
}

function isUnknownChannelError(error) {
  const message = String(error?.message || "");
  return message.includes("failed: 404") && /"code"\s*:\s*10003/.test(message);
}
