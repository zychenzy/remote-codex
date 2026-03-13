import { BaseAdapter } from "./base-adapter.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RATE_LIMIT_RETRIES = 3;
const DISCORD_MAX_CONTENT = 1900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDiscordContent(text) {
  const raw = String(text || "");
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

export class DiscordAdapter extends BaseAdapter {
  constructor({
    token,
    allowedChannels = [],
    pollIntervalMs = 1800,
    minSendIntervalMs = 450,
    logger = console,
  } = {}) {
    super({ channel: "discord", logger });
    this.token = token;
    this.allowedChannels = allowedChannels;
    this.pollIntervalMs = pollIntervalMs;
    this.minSendIntervalMs = minSendIntervalMs;
    this.running = false;
    this.loopTimer = null;
    this.lastSeenByChannel = new Map();
    this.invalidChannels = new Set();
    this.sendQueue = Promise.resolve();
    this.nextAllowedSendAt = 0;
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
  }

  async sendMessage(context, text) {
    const content = formatDiscordContent(text);
    if (!content.trim()) {
      return;
    }
    await this.#enqueueSend(async () => {
      await this.#api(`/channels/${context.chatId}/messages`, {
        method: "POST",
        body: {
          content,
        },
      });
    });
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
