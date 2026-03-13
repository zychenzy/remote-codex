import { allAgentTextFromTurn, allUserTextFromTurn } from "./turn-text-utils.js";

function clipText(text, maxLen = 400) {
  const input = String(text || "");
  if (!maxLen || input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, maxLen - 3)}...`;
}

function prefixFirstLineOnly(marker, text) {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.length) {
    return "";
  }
  const [first, ...rest] = lines;
  return [
    `${marker} ${first}`,
    ...rest.map((line) => `  ${line}`),
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ThreadHistoryPresenter {
  constructor({ runtime, logger = console, sendMessage, sendLongMessage } = {}) {
    this.runtime = runtime;
    this.logger = logger;
    this.sendMessage = sendMessage;
    this.sendLongMessage = sendLongMessage;
  }

  async renderMessages(threadId, { turns = null, textLimit = null } = {}) {
    try {
      const read = await this.runtime.readThread({ threadId, includeTurns: true });
      const allTurns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
      const selectedTurns = Number.isFinite(Number(turns))
        ? allTurns.slice(-Math.max(0, Number(turns)))
        : allTurns;
      if (!selectedTurns.length) {
        return [];
      }

      const messages = [];
      if (selectedTurns.length < allTurns.length) {
        messages.push(`Thread history (${selectedTurns.length}/${allTurns.length} turns shown):`);
      } else {
        messages.push(`Thread history (${allTurns.length} turns):`);
      }

      for (const turn of selectedTurns) {
        const lines = [];
        const userRaw = String(allUserTextFromTurn(turn) || "").trim();
        const agentRaw = String(allAgentTextFromTurn(turn) || "").trim();
        const userText = textLimit ? clipText(userRaw, textLimit) : userRaw;
        const agentText = textLimit ? clipText(agentRaw, textLimit) : agentRaw;
        if (userText) {
          lines.push(prefixFirstLineOnly("◇", userText));
        }
        if (agentText) {
          lines.push(prefixFirstLineOnly("•", agentText));
        }
        if (!userText && !agentText) {
          lines.push("(no visible text content)");
        }
        messages.push(lines.join("\n"));
      }

      return messages.filter(Boolean);
    } catch (error) {
      this.logger.debug(`failed to load thread history for ${threadId}: ${error.message}`);
      return [];
    }
  }

  async send(adapter, context, threadId, options = {}) {
    const messages = await this.renderMessages(threadId, options);
    if (!messages.length) {
      return;
    }
    for (let index = 0; index < messages.length; index += 1) {
      const historyBlock = String(messages[index] || "");
      if (historyBlock.length <= 1850) {
        await this.sendMessage(adapter, context, historyBlock);
      } else {
        await this.sendLongMessage(adapter, context, historyBlock, {
          maxLen: 1850,
          delayMs: adapter.channel === "discord" ? 300 : 0,
        });
      }
      if (adapter.channel === "discord" && index < messages.length - 1) {
        await sleep(220);
      }
    }
  }
}
