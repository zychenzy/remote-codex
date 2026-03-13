import { detectDelta, detectThreadId, detectTurnId } from "./utils.js";

function normalizeTurnStatus(status) {
  if (typeof status === "string" && status.trim()) {
    return status;
  }
  if (status && typeof status === "object" && typeof status.type === "string" && status.type.trim()) {
    return status.type;
  }
  return "completed";
}

function fileChangeDiffText(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const blocks = [];
  for (const change of changes) {
    const diff = String(change?.diff || "").trim();
    if (!diff) {
      continue;
    }
    const filePath = String(change?.path || "").trim();
    const header = filePath ? `Path: ${filePath}` : "Path: (unknown)";
    blocks.push([
      header,
      "```diff",
      diff,
      "```",
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

export class TurnEventRouter {
  constructor({
    threadToBinding,
    turnToBinding,
    activeTurnByBinding,
    suppressedTurnIds,
    turnOutput,
    store,
    outputPolicy,
    getAdapter,
    sendMessage,
    sendLongMessage,
    sendMessageRaw,
    sendLongMessageRaw,
    sendStreamingDelta,
    allAgentTextFromTurn,
    onSkillsChanged = () => {},
  } = {}) {
    this.threadToBinding = threadToBinding;
    this.turnToBinding = turnToBinding;
    this.activeTurnByBinding = activeTurnByBinding;
    this.suppressedTurnIds = suppressedTurnIds;
    this.turnOutput = turnOutput;
    this.store = store;
    this.outputPolicy = outputPolicy;
    this.getAdapter = getAdapter;
    this.sendMessage = sendMessage;
    this.sendLongMessage = sendLongMessage;
    this.sendMessageRaw = sendMessageRaw || sendMessage;
    this.sendLongMessageRaw = sendLongMessageRaw || sendLongMessage;
    this.sendStreamingDelta = sendStreamingDelta;
    this.allAgentTextFromTurn = allAgentTextFromTurn;
    this.onSkillsChanged = onSkillsChanged;
    this.deliveredFileChangeItemIds = new Set();
  }

  async handle(notification) {
    const { method, params } = notification || {};
    if (!method) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      await this.#handleAgentDelta(params);
      return;
    }

    if (method === "turn/started") {
      this.#handleTurnStarted(params);
      return;
    }

    if (method === "item/completed") {
      await this.#handleItemCompleted(params);
      return;
    }

    if (method === "turn/completed") {
      await this.#handleTurnCompleted(params);
      return;
    }

    if (method === "thread/started") {
      const threadId = detectThreadId(params);
      if (!threadId) {
        return;
      }
      this.store.appendAudit({ type: "thread_started", threadId });
      return;
    }

    if (method === "thread/status/changed") {
      const threadId = detectThreadId(params) || params?.threadId;
      this.store.appendAudit({
        type: "thread_status_changed",
        threadId: threadId || null,
        status: params?.status?.type || "unknown",
      });
      return;
    }

    if (method === "thread/closed") {
      this.#handleThreadClosed(params);
      return;
    }

    if (method === "thread/archived") {
      this.#handleThreadArchived(params);
      return;
    }

    if (method === "thread/unarchived") {
      const threadId = detectThreadId(params) || params?.threadId;
      this.store.appendAudit({ type: "thread_unarchived", threadId: threadId || null });
      return;
    }

    if (method === "skills/changed") {
      this.onSkillsChanged();
      this.store.appendAudit({ type: "skills_changed" });
      return;
    }

    if (method === "error") {
      await this.#handleRuntimeError(params);
    }
  }

  async #handleAgentDelta(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const delta = detectDelta(params);
    if (!delta) {
      return;
    }

    let bKey = null;
    if (turnId) {
      if (this.suppressedTurnIds.has(String(turnId))) {
        return;
      }
      bKey = this.turnToBinding.get(turnId);
    } else {
      bKey = this.threadToBinding.get(threadId);
    }
    if (!bKey) {
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.getAdapter(channel);
    if (!adapter) {
      return;
    }

    const sectionUpdate = this.turnOutput.appendDelta(threadId, turnId, bKey, delta);
    if (adapter.channel === "discord") {
      if (sectionUpdate.sectionText) {
        await this.sendLongMessage(
          adapter,
          { channel, chatId, threadId, turnId },
          sectionUpdate.sectionText,
          {
            maxLen: this.outputPolicy.liveSectionMaxLen,
            delayMs: this.outputPolicy.liveSectionDelayMs,
          }
        );
      }
    } else {
      await this.sendStreamingDelta(adapter, { channel, chatId, threadId, turnId }, delta);
    }
  }

  #handleTurnStarted(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const bKey = this.threadToBinding.get(threadId);
    if (bKey && turnId) {
      this.turnToBinding.set(turnId, bKey);
      this.activeTurnByBinding.set(bKey, turnId);
    }
  }

  async #handleItemCompleted(params) {
    const item = params?.item || {};
    if (item?.type !== "fileChange") {
      return;
    }

    const itemId = String(item?.id || params?.itemId || "").trim();
    if (itemId && this.deliveredFileChangeItemIds.has(itemId)) {
      return;
    }

    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (turnId && this.suppressedTurnIds.has(String(turnId))) {
      return;
    }

    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel, chatId] = bKey.split(":");
    const adapter = this.getAdapter(channel);
    if (!adapter) {
      return;
    }

    const diffText = fileChangeDiffText(item);
    if (!diffText) {
      return;
    }

    if (itemId) {
      this.deliveredFileChangeItemIds.add(itemId);
      if (this.deliveredFileChangeItemIds.size > 2000) {
        const oldest = this.deliveredFileChangeItemIds.values().next().value;
        if (oldest) {
          this.deliveredFileChangeItemIds.delete(oldest);
        }
      }
    }

    await this.sendLongMessageRaw(
      adapter,
      { channel, chatId, threadId, turnId },
      diffText,
      {
        maxLen: this.outputPolicy.liveSectionMaxLen,
        delayMs: this.outputPolicy.liveSectionDelayMs,
      }
    );
  }

  async #handleTurnCompleted(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const suppressed = Boolean(turnId && this.suppressedTurnIds.has(String(turnId)));
    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    const finalFromStream = this.turnOutput.takeFinal(threadId, turnId);
    if (!bKey) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
      }
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.getAdapter(channel);
    const status = normalizeTurnStatus(params?.turn?.status);
    if (adapter && !suppressed) {
      const fullAssistant = String(
        finalFromStream.fullText || this.allAgentTextFromTurn(params?.turn || {})
      ).trim();
      const pendingAssistant = String(
        finalFromStream.pendingText || ""
      ).trim();
      if (pendingAssistant) {
        await this.sendLongMessage(
          adapter,
          { channel, chatId, threadId, turnId },
          pendingAssistant,
          {
            maxLen: this.outputPolicy.liveSectionMaxLen,
            delayMs: this.outputPolicy.liveSectionDelayMs,
          }
        );
      } else if (!fullAssistant) {
        await this.sendMessage(adapter, { channel, chatId, turnId }, `Turn completed (${status}).`);
      }
    } else if (adapter && suppressed && adapter.channel === "discord") {
      const partial = String(finalFromStream.pendingText || "").trim();
      if (partial) {
        await this.sendLongMessage(adapter, { channel, chatId, threadId, turnId }, partial, {
          maxLen: this.outputPolicy.liveSectionMaxLen,
          delayMs: this.outputPolicy.liveSectionDelayMs,
        });
      }
    }
    if (turnId) {
      this.suppressedTurnIds.delete(String(turnId));
    }
    this.turnToBinding.delete(turnId);
    this.activeTurnByBinding.delete(bKey);
  }

  #handleThreadClosed(params) {
    const threadId = detectThreadId(params) || params?.threadId;
    if (threadId) {
      const bKey = this.threadToBinding.get(threadId);
      this.threadToBinding.delete(threadId);
      if (bKey) {
        for (const [turnId, key] of this.turnToBinding.entries()) {
          if (key === bKey) {
            this.turnToBinding.delete(turnId);
          }
        }
        this.activeTurnByBinding.delete(bKey);
        this.turnOutput.clearByBinding(bKey);
      }
    }
    this.store.appendAudit({ type: "thread_closed", threadId: threadId || null });
  }

  #handleThreadArchived(params) {
    const threadId = detectThreadId(params) || params?.threadId;
    if (threadId) {
      const bKey = this.threadToBinding.get(threadId);
      this.threadToBinding.delete(threadId);
      if (bKey) {
        this.turnOutput.clearByBinding(bKey);
        const [channel, chatId] = bKey.split(":");
        const binding = this.store.getBinding(channel, chatId);
        if (binding?.threadId === threadId) {
          this.store.upsertBinding({
            ...binding,
            threadId: null,
          });
        }
      }
    }
    this.store.appendAudit({ type: "thread_archived", threadId: threadId || null });
  }

  async #handleRuntimeError(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const suppressed = Boolean(turnId && this.suppressedTurnIds.has(String(turnId)));
    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    const finalFromStream = this.turnOutput.takeFinal(threadId, turnId);
    if (!bKey) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
      }
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.getAdapter(channel);
    if (!adapter) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
      }
      return;
    }

    const errorMessage = `Runtime error: ${params?.error?.message || "unknown"}`;
    const partial = String(
      finalFromStream.pendingText || this.allAgentTextFromTurn(params?.turn || {})
    ).trim();
    if (partial) {
      await this.sendLongMessage(adapter, { channel, chatId, threadId, turnId }, partial, {
        maxLen: this.outputPolicy.liveSectionMaxLen,
        delayMs: this.outputPolicy.liveSectionDelayMs,
      });
    }
    if (!suppressed) {
      await this.sendMessage(adapter, { channel, chatId, turnId }, errorMessage);
    }
    if (turnId) {
      this.suppressedTurnIds.delete(String(turnId));
      this.turnToBinding.delete(turnId);
    }
    this.activeTurnByBinding.delete(bKey);
  }
}
