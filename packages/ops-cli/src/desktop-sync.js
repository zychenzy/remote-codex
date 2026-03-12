import { execFile, exec } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function execShellAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export class DesktopSyncWorkaround {
  constructor({
    logger = console,
    platform = process.platform,
    debounceMs = 1200,
    commandTemplate = "",
  } = {}) {
    this.logger = logger;
    this.platform = platform;
    this.debounceMs = debounceMs;
    this.commandTemplate = String(commandTemplate || "").trim();
    this.timers = new Map();
    this.disabled = false;
  }

  schedule({ threadId, reason = "" } = {}) {
    if (!threadId || this.disabled) {
      return;
    }

    if (this.platform !== "darwin" && !this.commandTemplate) {
      return;
    }

    const key = String(threadId);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.#run({ threadId: key, reason }).catch((error) => {
        this.logger.warn(`desktop sync failed: ${error.message}`);
      });
    }, this.debounceMs);
    this.timers.set(key, timer);
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  async #run({ threadId, reason }) {
    this.timers.delete(String(threadId));
    if (this.disabled) {
      return;
    }

    if (this.commandTemplate) {
      const command = this.commandTemplate.replaceAll("{threadId}", String(threadId));
      await execShellAsync(command);
      this.logger.debug(`desktop sync command executed for ${threadId}${reason ? ` (${reason})` : ""}`);
      return;
    }

    if (this.platform !== "darwin") {
      return;
    }

    try {
      await execFileAsync("open", ["codex://settings"]);
      await sleep(120);
      await execFileAsync("open", [`codex://threads/${threadId}`]);
      this.logger.debug(`desktop sync refresh executed for ${threadId}${reason ? ` (${reason})` : ""}`);
    } catch (error) {
      this.disabled = true;
      this.logger.warn(
        `desktop sync disabled for this daemon run after refresh failure: ${error.message}`
      );
    }
  }
}

