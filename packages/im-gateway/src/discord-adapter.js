import { BaseAdapter } from "./base-adapter.js";

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordAdapter extends BaseAdapter {
  constructor({ token, allowedChannels = [], pollIntervalMs = 1800, logger = console } = {}) {
    super({ channel: "discord", logger });
    this.token = token;
    this.allowedChannels = allowedChannels;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.loopTimer = null;
    this.lastSeenByChannel = new Map();
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
    await this.#api(`/channels/${context.chatId}/messages`, {
      method: "POST",
      body: {
        content: text.slice(0, 1900),
      },
    });
  }

  async #pollLoop() {
    if (!this.running) {
      return;
    }

    try {
      for (const channelId of this.allowedChannels) {
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
      }
    } catch (error) {
      this.logger.error(`[discord] polling error: ${error.message}`);
    }

    this.loopTimer = setTimeout(() => {
      this.#pollLoop().catch((err) => this.logger.error(`[discord] loop failed: ${err.message}`));
    }, this.pollIntervalMs);
  }

  async #api(path, { method = "GET", body = null } = {}) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`discord ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }
}
