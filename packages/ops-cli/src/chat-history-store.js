import fs from "node:fs";
import fsp from "node:fs/promises";

export class ChatHistoryStore {
  constructor({ getFilePath, flushIntervalMs = 250, logger = console } = {}) {
    this.getFilePath = getFilePath;
    this.flushIntervalMs = flushIntervalMs;
    this.logger = logger;
    this.buffer = [];
    this.flushTimer = null;
    this.flushChain = Promise.resolve();
  }

  append(entry) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    this.buffer.push(line);
    this.#scheduleFlush();
  }

  async flush({ force = false } = {}) {
    if (this.flushTimer && force) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.buffer.length) {
      if (force) {
        await this.flushChain.catch(() => {});
      }
      return;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    const payload = `${batch.join("\n")}\n`;
    const filePath = this.#filePath();
    const writeTask = this.flushChain
      .catch(() => {})
      .then(() => fsp.appendFile(filePath, payload, { encoding: "utf8" }));
    this.flushChain = writeTask.catch(() => {});

    try {
      await writeTask;
    } catch (error) {
      if (force) {
        try {
          fs.appendFileSync(filePath, payload, { encoding: "utf8" });
          return;
        } catch (syncError) {
          this.logger?.warn?.(`failed to force-flush chat history: ${syncError.message}`);
        }
      } else {
        this.logger?.warn?.(`failed to append chat history: ${error.message}`);
      }
      this.buffer = [...batch, ...this.buffer];
      this.#scheduleFlush();
    }
  }

  #scheduleFlush() {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        this.logger?.warn?.(`failed to flush chat history: ${error.message}`);
      });
    }, this.flushIntervalMs);
  }

  #filePath() {
    if (typeof this.getFilePath === "function") {
      return this.getFilePath();
    }
    return String(this.getFilePath || "");
  }
}
