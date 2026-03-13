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

function normalizeChangeKind(kind) {
  return String(kind || "").trim().toLowerCase();
}

function isWholeFileChange(kind) {
  const normalized = normalizeChangeKind(kind);
  return ["added", "deleted", "removed"].includes(normalized);
}

function wholeFilePlaceholderDiff(kind, filePath) {
  const normalized = normalizeChangeKind(kind);
  const safePath = String(filePath || "").trim();
  if (normalized === "added") {
    const rhs = safePath ? `b/${safePath}` : "/dev/null";
    return [
      `+++ ${rhs}`,
      "+ [full file content omitted]",
    ].join("\n");
  }
  const lhs = safePath ? `a/${safePath}` : "/dev/null";
  return [
    `--- ${lhs}`,
    "- [full file content omitted]",
  ].join("\n");
}

function fileChangeDiffText(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const blocks = [];
  for (const change of changes) {
    const kind = normalizeChangeKind(change?.kind);
    const filePath = String(change?.path || "").trim();
    const header = filePath
      ? `Path: ${filePath}${kind ? ` (${kind})` : ""}`
      : `Path: (unknown)${kind ? ` (${kind})` : ""}`;
    if (isWholeFileChange(kind)) {
      blocks.push(formatDiffBlock(header, wholeFilePlaceholderDiff(kind, filePath)));
      continue;
    }

    const diff = String(change?.diff || "").trim();
    if (!diff) {
      continue;
    }
    blocks.push([
      header,
      "```diff",
      diff,
      "```",
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

function trimToLimit(text, maxLen = 120_000) {
  const input = String(text || "");
  if (!input) {
    return "";
  }
  if (input.length <= maxLen) {
    return input;
  }
  return input.slice(input.length - maxLen);
}

function cacheKeyFromIds(threadId, turnId) {
  const turn = String(turnId || "").trim();
  if (turn) {
    return `turn:${turn}`;
  }
  const thread = String(threadId || "").trim();
  if (thread) {
    return `thread:${thread}`;
  }
  return "";
}

function hasWholeFileChanges(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.some((change) => isWholeFileChange(change?.kind));
}

function isUnifiedDiffText(text) {
  const input = String(text || "");
  return /(^|\n)(diff --git |@@ |--- |\+\+\+ )/.test(input);
}

function formatDiffBlock(header, diffText) {
  return [
    header,
    "```diff",
    String(diffText || "").trim(),
    "```",
  ].join("\n");
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
    this.fileChangeOutputByItemId = new Map();
    this.latestTurnDiffByKey = new Map();
    this.deliveredTurnDiffByKey = new Set();
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

    if (method === "item/fileChange/outputDelta") {
      this.#handleFileChangeOutputDelta(params);
      return;
    }

    if (method === "turn/diff/updated") {
      this.#handleTurnDiffUpdated(params);
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

    const cacheKey = cacheKeyFromIds(threadId, turnId);
    const turnDiffText = cacheKey ? String(this.latestTurnDiffByKey.get(cacheKey) || "").trim() : "";
    const toolOutputText = itemId ? String(this.fileChangeOutputByItemId.get(itemId) || "").trim() : "";
    if (itemId) {
      this.fileChangeOutputByItemId.delete(itemId);
    }

    const perItemDiff = fileChangeDiffText(item);
    const preferPerItem = hasWholeFileChanges(item);
    let diffText = "";
    if (preferPerItem && perItemDiff) {
      diffText = perItemDiff;
    } else if (turnDiffText && !this.deliveredTurnDiffByKey.has(cacheKey) && isUnifiedDiffText(turnDiffText)) {
      diffText = formatDiffBlock("Turn diff (aggregated)", turnDiffText);
      this.deliveredTurnDiffByKey.add(cacheKey);
      if (this.deliveredTurnDiffByKey.size > 2000) {
        const oldest = this.deliveredTurnDiffByKey.values().next().value;
        if (oldest) {
          this.deliveredTurnDiffByKey.delete(oldest);
        }
      }
    } else {
      if (perItemDiff) {
        diffText = perItemDiff;
      } else if (toolOutputText && isUnifiedDiffText(toolOutputText)) {
        diffText = formatDiffBlock("Patch diff", toolOutputText);
      }
    }
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
    const cacheKey = cacheKeyFromIds(threadId, turnId);
    if (cacheKey) {
      this.latestTurnDiffByKey.delete(cacheKey);
      this.deliveredTurnDiffByKey.delete(cacheKey);
    }
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

  #handleFileChangeOutputDelta(params) {
    const itemId = String(params?.itemId || params?.item?.id || "").trim();
    if (!itemId) {
      return;
    }
    const delta = detectDelta(params) || params?.outputDelta || "";
    if (!delta) {
      return;
    }
    const existing = String(this.fileChangeOutputByItemId.get(itemId) || "");
    this.fileChangeOutputByItemId.set(itemId, trimToLimit(`${existing}${String(delta)}`));
    if (this.fileChangeOutputByItemId.size > 2000) {
      const oldest = this.fileChangeOutputByItemId.keys().next().value;
      if (oldest) {
        this.fileChangeOutputByItemId.delete(oldest);
      }
    }
  }

  #handleTurnDiffUpdated(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const key = cacheKeyFromIds(threadId, turnId);
    if (!key) {
      return;
    }
    const diff = String(params?.diff || detectDelta(params) || "").trim();
    if (!diff) {
      return;
    }
    this.latestTurnDiffByKey.set(key, trimToLimit(diff));
    if (this.latestTurnDiffByKey.size > 2000) {
      const oldest = this.latestTurnDiffByKey.keys().next().value;
      if (oldest) {
        this.latestTurnDiffByKey.delete(oldest);
      }
    }
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
