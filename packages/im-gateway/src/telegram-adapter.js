import { BaseAdapter } from "./base-adapter.js";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramAdapter extends BaseAdapter {
  constructor({ token, pollIntervalMs = 1200, logger = console } = {}) {
    super({ channel: "telegram", logger });
    this.token = token;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.offset = 0;
    this.loopTimer = null;
  }

  async start() {
    if (!this.token) {
      this.logger.warn("[telegram] token missing; adapter disabled");
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
    await this.#api("sendMessage", {
      chat_id: context.chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  async #pollLoop() {
    if (!this.running) {
      return;
    }

    try {
      const result = await this.#api("getUpdates", {
        timeout: 20,
        offset: this.offset,
      });

      for (const update of result || []) {
        this.offset = Math.max(this.offset, (update.update_id || 0) + 1);
        const message = update.message;
        if (!message || !message.text) {
          continue;
        }

        this.emitInbound({
          channel: "telegram",
          chatId: String(message.chat?.id || ""),
          userId: String(message.from?.id || ""),
          userName: message.from?.username || message.from?.first_name || "",
          text: message.text,
          raw: update,
        });
      }
    } catch (error) {
      this.logger.error(`[telegram] polling error: ${error.message}`);
    }

    this.loopTimer = setTimeout(() => {
      this.#pollLoop().catch((err) => this.logger.error(`[telegram] loop failed: ${err.message}`));
    }, this.pollIntervalMs);
  }

  async #api(method, payload) {
    const response = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`telegram ${method} failed: ${response.status} ${text}`);
    }

    const json = await response.json();
    if (!json.ok) {
      throw new Error(`telegram ${method} rejected: ${json.description || "unknown"}`);
    }
    return json.result;
  }
}
