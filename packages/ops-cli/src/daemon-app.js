import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { AppServerRuntime } from "../../core-runtime/src/index.js";
import {
  DiscordAdapter,
  parseIncomingCommand,
} from "../../im-gateway/src/index.js";
import { StateStore } from "../../state-store/src/index.js";
import { ApprovalBroker } from "./approval-broker.js";
import { ChatHistoryStore } from "./chat-history-store.js";
import { InboundCommandService } from "./inbound-command-service.js";
import { createLogger } from "./logger.js";
import { handleModelAndSkillsCommand } from "./model-skills-handler.js";
import { reconcileRuntimeState } from "./runtime-state-reconciler.js";
import { ThreadHistoryPresenter } from "./thread-history-presenter.js";
import { allAgentTextFromTurn } from "./turn-text-utils.js";
import { TurnEventRouter } from "./turn-event-router.js";
import { TurnOutputService } from "./turn-output-service.js";
import { startTurnWithRecovery } from "./turn-recovery.js";
import { detectThreadId, detectTurnId } from "./utils.js";

function bindingKey(channel, chatId) {
  return `${channel}:${chatId}`;
}

function threadIdFromResponse(response) {
  return response?.thread?.id || response?.threadId || response?.thread_id || null;
}

function turnIdFromResponse(response) {
  return response?.turn?.id || response?.turnId || response?.turn_id || null;
}

function supportedApprovalMethod(method) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput"
  );
}

function makeLaunchSpec(config) {
  if (config?.runtime?.appServer?.command) {
    return {
      command: config.runtime.appServer.command,
      args: config.runtime.appServer.args || [],
      description: `${config.runtime.appServer.command} ${(config.runtime.appServer.args || []).join(" ")}`,
      options: {},
    };
  }

  return null;
}

function resolveWorkspacePath(inputPath, currentWorkingDir) {
  const trimmed = String(inputPath || "").trim();
  if (!trimmed) {
    return { value: currentWorkingDir };
  }

  let candidate = trimmed;
  if (candidate.startsWith("~")) {
    candidate = path.join(os.homedir(), candidate.slice(1));
  } else if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(currentWorkingDir, candidate);
  }

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return { error: `Not a directory: ${candidate}` };
    }
  } catch {
    return { error: `Directory does not exist: ${candidate}` };
  }

  return { value: candidate };
}

function isThreadNotFoundError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found");
}

function threadListFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }

  const candidates = [
    response?.threads,
    response?.items,
    response?.data?.threads,
    response?.data?.items,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function singleLine(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function threadDisplayTitle(thread) {
  const raw = thread?.name || thread?.title || thread?.preview || "";
  const text = singleLine(raw);
  if (!text) {
    return "(no title)";
  }
  if (text.length <= 96) {
    return text;
  }
  return `${text.slice(0, 93)}...`;
}

function extractThreadId(thread) {
  return String(thread?.id || thread?.threadId || thread?.thread_id || "");
}

function extractThreadCwd(thread) {
  const cwd = singleLine(thread?.cwd || "");
  return cwd || "";
}

function parseArgsAndOptions(args = []) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next == null || String(next).startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = String(next);
    i += 1;
  }
  return { positional, options };
}

function toBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toInt(value, fallback = 10, min = 1, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

function nextCursorFromResponse(response) {
  return response?.nextCursor || response?.next_cursor || response?.cursor || null;
}

function modelListFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.models)) {
    return response.models;
  }
  return [];
}

function collaborationModesFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.modes)) {
    return response.modes;
  }
  return [];
}

function skillsEntriesFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  return [];
}

function formatRuntimeError(error) {
  const message = String(error?.message || "unknown error");
  const lower = message.toLowerCase();
  if (lower.includes("not initialized")) {
    return "Runtime is not initialized yet. Retry in a moment or run `reco restart`.";
  }
  if (lower.includes("thread not found")) {
    return "Thread not found. Use `/thread list` or start a new one with `/new`.";
  }
  if (lower.includes("method not found")) {
    return "This command is not supported by your current codex app-server version.";
  }
  if (lower.includes("requires experimentalapi capability")) {
    return "This command requires experimental API support from codex app-server. Check your runtime version.";
  }
  if (lower.includes("operation not permitted")) {
    return "Operation not permitted by runtime or file permissions.";
  }
  if (lower.includes("server overloaded")) {
    return "Runtime is overloaded. Retry shortly.";
  }
  return `Runtime error: ${message}`;
}

function riskyThreadActionRequiresConfirm(approvalMode) {
  return approvalMode !== "never";
}

function extractSkillNameFromPrompt(prompt = "") {
  const match = String(prompt || "").match(/\$([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function splitTextIntoChunks(text, maxLen = 1600) {
  const input = String(text || "").replace(/\r/g, "");
  if (!input) {
    return [];
  }
  if (input.length <= maxLen) {
    return [input];
  }

  const lines = input.split("\n");
  const chunks = [];
  let current = "";
  let inFence = false;
  let fenceHeader = "```";

  const pushCurrent = () => {
    const out = current.trimEnd();
    if (out) {
      chunks.push(out);
    }
    current = "";
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const lineWithNl = `${line}\n`;
    const trimmed = line.trim();
    const isFenceLine = trimmed.startsWith("```");

    if (current.length > 0 && current.length + lineWithNl.length > maxLen) {
      if (inFence) {
        current += "```\n";
        pushCurrent();
        current = `${fenceHeader}\n`;
      } else {
        pushCurrent();
      }
    }

    current += lineWithNl;

    if (isFenceLine) {
      if (!inFence) {
        inFence = true;
        fenceHeader = trimmed || "```";
      } else {
        inFence = false;
        fenceHeader = "```";
      }
    }
  }

  if (current.trim()) {
    if (inFence) {
      current += "\n```";
    }
    pushCurrent();
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonApp {
  constructor({ baseDir } = {}) {
    this.store = new StateStore({ baseDir });
    this.config = this.store.readConfig();

    this.logger = createLogger({
      filePath: path.join(this.store.logsDir, "daemon.log"),
      level: process.env.IM_CODEX_LOG_LEVEL || "info",
    });

    const outputConfig = this.config.defaults?.output || {};
    this.outputPolicy = {
      resumeHistoryTurns: toInt(outputConfig.resumeHistoryTurns, 5, 1, 100),
      chatHistoryFlushIntervalMs: toInt(outputConfig.chatHistoryFlushIntervalMs, 250, 10, 10_000),
      turnOutputMinChunkChars: toInt(outputConfig.turnOutputMinChunkChars, 160, 40, 8_000),
      turnOutputSoftChunkChars: toInt(outputConfig.turnOutputSoftChunkChars, 280, 40, 8_000),
      liveSectionMaxLen: toInt(outputConfig.liveSectionMaxLen, 1400, 200, 1900),
      liveSectionDelayMs: toInt(outputConfig.liveSectionDelayMs, 250, 0, 10_000),
    };

    this.chatHistoryPath = path.join(this.store.logsDir, "chat-history.jsonl");
    this.chatHistory = new ChatHistoryStore({
      getFilePath: () => this.chatHistoryPath,
      flushIntervalMs: this.outputPolicy.chatHistoryFlushIntervalMs,
      logger: this.logger,
    });

    this.runtime = new AppServerRuntime({
      launchSpec: makeLaunchSpec(this.config),
      logger: this.logger,
      reconnect: true,
    });

    this.approvalBroker = new ApprovalBroker({ timeoutMs: 5 * 60 * 1000 });
    this.adapters = [];

    this.threadToBinding = new Map();
    this.turnToBinding = new Map();
    this.activeTurnByBinding = new Map();
    this.suppressedTurnIds = new Set();
    this.turnOutput = new TurnOutputService({
      minChunkChars: this.outputPolicy.turnOutputMinChunkChars,
      softChunkChars: this.outputPolicy.turnOutputSoftChunkChars,
    });
    this.threadListStateByBinding = new Map();
    this.skillsCacheByCwd = new Map();

    this.turnEventRouter = new TurnEventRouter({
      threadToBinding: this.threadToBinding,
      turnToBinding: this.turnToBinding,
      activeTurnByBinding: this.activeTurnByBinding,
      suppressedTurnIds: this.suppressedTurnIds,
      turnOutput: this.turnOutput,
      store: this.store,
      outputPolicy: this.outputPolicy,
      getAdapter: (channel) => this.#getAdapter(channel),
      sendMessage: (adapter, context, text) => this.#sendMessage(adapter, context, text),
      sendLongMessage: (adapter, context, text, options) => this.#sendLongMessage(adapter, context, text, options),
      sendMessageRaw: (adapter, context, text) => this.#sendMessageRaw(adapter, context, text),
      sendLongMessageRaw: (adapter, context, text, options) => this.#sendLongMessageRaw(adapter, context, text, options),
      sendStreamingDelta: (adapter, context, delta) => this.#sendStreamingDelta(adapter, context, delta),
      allAgentTextFromTurn,
      onSkillsChanged: () => this.skillsCacheByCwd.clear(),
    });

    this.threadHistoryPresenter = new ThreadHistoryPresenter({
      getRuntime: () => this.runtime,
      logger: this.logger,
      sendMessage: (adapter, context, text) => this.#sendMessage(adapter, context, text),
      sendLongMessage: (adapter, context, text, options) => this.#sendLongMessage(adapter, context, text, options),
    });

    this.inboundCommands = new InboundCommandService({
      parseIncomingCommand,
      handleModelAndSkillsCommand,
      getRuntime: () => this.runtime,
      getStore: () => this.store,
      getApprovalBroker: () => this.approvalBroker,
      getOutputPolicy: () => this.outputPolicy,
      threadToBinding: this.threadToBinding,
      turnToBinding: this.turnToBinding,
      activeTurnByBinding: this.activeTurnByBinding,
      suppressedTurnIds: this.suppressedTurnIds,
      getAdapter: (channel) => this.#getAdapter(channel),
      ensureBinding: (context) => this.#ensureBinding(context),
      appendChatHistory: (entry) => this.chatHistory.append(entry),
      sendMessage: (adapter, context, text) => this.#sendMessage(adapter, context, text),
      sendMessageRaw: (adapter, context, text) => this.#sendMessageRaw(adapter, context, text),
      sendLongMessageRaw: (adapter, context, text, options) => this.#sendLongMessageRaw(adapter, context, text, options),
      isAuthorized: (binding, context) => this.#isAuthorized(binding, context),
      startTurnWithRecovery: (adapter, context, binding, bKey, prompt, overrides) => (
        this.#startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides)
      ),
      startFreshThreadForBinding: (binding, bKey) => this.#startFreshThreadForBinding(binding, bKey),
      sendThreadHistory: (adapter, context, threadId, options) => (
        this.threadHistoryPresenter.send(adapter, context, threadId, options)
      ),
      setThreadListState: (bKey, state) => this.#setThreadListState(bKey, state),
      getThreadListState: (bKey) => this.#getThreadListState(bKey),
      resolveThreadCwd: (threadId) => this.#resolveThreadCwd(threadId),
      loadSkillsForCwd: (cwd, options) => this.#loadSkillsForCwd(cwd, options),
      touchSkillsContext: (binding, cwd, skills) => this.#touchSkillsContext(binding, cwd, skills),
      resolveSkillByName: (binding, cwd, name, options) => this.#resolveSkillByName(binding, cwd, name, options),
      clearSkillCache: (cwd) => this.skillsCacheByCwd.delete(cwd),
      bindingKeyFn: bindingKey,
      parseArgsAndOptions,
      resolveWorkspacePath,
      toBoolean,
      toInt,
      isThreadNotFoundError,
      riskyThreadActionRequiresConfirm,
      threadIdFromResponse,
      turnIdFromResponse,
      threadListFromResponse,
      nextCursorFromResponse,
      extractThreadId,
      threadDisplayTitle,
      extractThreadCwd,
      modelListFromResponse,
      collaborationModesFromResponse,
    });

    this.running = false;
  }

  async start() {
    this.running = true;

    this.#wireRuntimeEvents();
    this.#wireApprovalBroker();

    await this.runtime.initialize();
    this.logger.info("runtime initialized");
    await this.#rehydrateRuntimeState("startup");

    await this.#startAdapters();
    this.logger.info("adapters started", this.adapters.map((adapter) => adapter.channel).join(","));

    this.store.appendAudit({ type: "daemon_started", pid: process.pid });
  }

  async stop() {
    this.running = false;
    this.approvalBroker.clearAll();
    this.#resetEphemeralTurnState();

    for (const adapter of this.adapters) {
      await adapter.stop();
    }

    await this.chatHistory.flush({ force: true });
    await this.store.flush();
    await this.runtime.stop();
    this.store.appendAudit({ type: "daemon_stopped", pid: process.pid });
    await this.store.flush();
  }

  #wireRuntimeEvents() {
    this.runtime.on("notification", (notification) => {
      this.#handleRuntimeNotification(notification).catch((error) => {
        this.logger.error("failed to handle runtime notification", error);
      });
    });

    this.runtime.on("serverRequest", (request) => {
      this.#handleServerRequest(request).catch((error) => {
        this.logger.error("failed to handle server request", error);
      });
    });

    this.runtime.on("stderr", (line) => {
      this.logger.debug("runtime stderr:", line.trim());
    });

    this.runtime.on("error", (error) => {
      this.logger.error("runtime error", error);
    });

    this.runtime.on("reconnected", () => {
      this.logger.warn("runtime reconnected");
      this.#rehydrateRuntimeState("reconnected").catch((error) => {
        this.logger.error("runtime state reconciliation failed after reconnect", error);
      });
    });
  }

  async #rehydrateRuntimeState(reason) {
    this.#resetEphemeralTurnState();
    const summary = await reconcileRuntimeState({
      store: this.store,
      runtime: this.runtime,
      logger: this.logger,
      threadToBinding: this.threadToBinding,
      turnToBinding: this.turnToBinding,
      activeTurnByBinding: this.activeTurnByBinding,
      bindingKeyFn: bindingKey,
      isThreadNotFoundError,
      extractThreadCwd,
    });
    this.store.appendAudit({
      type: "runtime_state_rehydrated",
      reason,
      ...summary,
    });
    this.logger.info(
      `runtime state reconciled (${reason}): loaded=${summary.loadedCount}, verified=${summary.verifiedThreads}, cwd_updated=${summary.refreshedCwd}, stale_cleared=${summary.clearedBindings}`
    );
  }

  #wireApprovalBroker() {
    this.approvalBroker.on("resolved", async (resolution) => {
      const { record } = resolution;
      this.store.resolvePendingApproval(resolution.localRequestId, {
        decision: resolution.decision,
        actor: resolution.actor || "system",
      });

      this.store.appendAudit({
        type: "approval_resolved",
        localRequestId: resolution.localRequestId,
        decision: resolution.decision,
        method: record.method,
      });

      await this.runtime.respondServerRequest(record.serverRequestId, resolution.response);

      const context = this.#contextFromBinding(record.binding);
      const adapter = this.#getAdapter(record.binding.channel);
      if (adapter) {
        const text = resolution.timeout
          ? `Approval timed out (${resolution.localRequestId}); defaulted to deny.`
          : `Approval ${resolution.decision === "allow" ? "granted" : "denied"} (${resolution.localRequestId}).`;
        await this.#sendMessage(adapter, context, text);
      }

      this.store.deletePendingApproval(resolution.localRequestId);
    });
  }

  async #startAdapters() {
    const channels = this.config.channels || {};

    if (channels.discord?.enabled && channels.discord.botToken) {
      const discord = new DiscordAdapter({
        token: channels.discord.botToken,
        allowedChannels: channels.discord.allowedChannels || [],
        logger: this.logger,
      });
      discord.registerInboundHandler((context) => {
        this.#handleInboundSafe(context).catch((error) => this.logger.error("discord inbound failed", error));
      });
      this.adapters.push(discord);
    }

    for (const adapter of this.adapters) {
      await adapter.start();
    }
  }

  #channelAllowlist(channel) {
    return this.config.channels?.[channel]?.allowlist || [];
  }

  #ensureBinding(context) {
    const existing = this.store.getBinding(context.channel, context.chatId);
    if (existing) {
      return existing;
    }

    const created = this.store.upsertBinding({
      channel: context.channel,
      chatId: context.chatId,
      userId: context.userId,
      threadId: null,
      workingDir: this.config.defaults?.workingDir || process.cwd(),
      policyProfile: {
        approvalMode: this.config.defaults?.approvalMode || "on-request",
        allowlist: this.#channelAllowlist(context.channel),
        autoApprove: false,
      },
    });

    this.store.appendAudit({
      type: "binding_created",
      channel: context.channel,
      chatId: context.chatId,
    });

    return created;
  }

  #contextFromBinding(binding) {
    return {
      channel: binding.channel,
      chatId: binding.chatId,
      userId: binding.userId || "",
      turnId: null,
    };
  }

  #isAuthorized(binding, context) {
    const allowlist = binding.policyProfile?.allowlist || [];
    if (!allowlist.length) {
      return false;
    }
    return allowlist.includes(String(context.userId));
  }

  #getAdapter(channel) {
    return this.adapters.find((adapter) => adapter.channel === channel) || null;
  }

  #resetEphemeralTurnState() {
    this.turnToBinding.clear();
    this.activeTurnByBinding.clear();
    this.turnOutput.reset();
    this.suppressedTurnIds.clear();
  }

  async #sendMessage(adapter, context, text) {
    this.chatHistory.append({
      direction: "outbound",
      type: "message",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      text: String(text || ""),
    });
    await adapter.sendMessage(context, text);
  }

  async #sendMessageRaw(adapter, context, text) {
    await adapter.sendMessage(context, text);
  }

  async #sendLongMessage(adapter, context, text, { maxLen = 1600, delayMs = 350 } = {}) {
    const chunks = splitTextIntoChunks(text, maxLen);
    if (!chunks.length) {
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.#sendMessage(adapter, context, chunk);
      if (delayMs > 0 && index < chunks.length - 1) {
        await sleep(delayMs);
      }
    }
  }

  async #sendLongMessageRaw(adapter, context, text, { maxLen = 1600, delayMs = 350 } = {}) {
    const chunks = splitTextIntoChunks(text, maxLen);
    if (!chunks.length) {
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.#sendMessageRaw(adapter, context, chunk);
      if (delayMs > 0 && index < chunks.length - 1) {
        await sleep(delayMs);
      }
    }
  }

  async #sendStreamingDelta(adapter, context, delta) {
    this.chatHistory.append({
      direction: "outbound",
      type: "stream_delta",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      text: String(delta || ""),
    });
    await adapter.sendStreamingDelta(context, delta);
  }

  async #sendApprovalPrompt(adapter, context, payload) {
    this.chatHistory.append({
      direction: "outbound",
      type: "approval_prompt",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      requestId: payload?.localRequestId || null,
      summary: payload?.summary || "",
      kind: payload?.kind || "",
    });
    await adapter.sendApprovalPrompt(context, payload);
  }

  async #startFreshThreadForBinding(binding, bKey) {
    const response = await this.runtime.startThread({
      cwd: binding.workingDir,
      approvalPolicy: binding.policyProfile.approvalMode,
      model: binding.policyProfile.model || null,
    });
    const threadId = threadIdFromResponse(response);
    if (threadId) {
      this.threadToBinding.set(threadId, bKey);
      this.store.setBindingThread(binding.channel, binding.chatId, threadId);
    }
    return threadId;
  }

  async #resolveThreadCwd(threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return "";
    }

    try {
      const read = await this.runtime.readThread({ threadId: id, includeTurns: false });
      const cwd = extractThreadCwd(read?.thread || read);
      if (cwd) {
        return cwd;
      }
    } catch {
      // continue to list fallback
    }

    try {
      const response = await this.runtime.listThreads({ limit: 200, archived: false });
      const threads = threadListFromResponse(response);
      const match = threads.find((thread) => extractThreadId(thread) === id);
      return extractThreadCwd(match);
    } catch {
      return "";
    }
  }

  #setThreadListState(bKey, state) {
    this.threadListStateByBinding.set(bKey, state);
  }

  #getThreadListState(bKey) {
    return this.threadListStateByBinding.get(bKey) || null;
  }

  async #loadSkillsForCwd(cwd, { forceReload = false } = {}) {
    const key = String(cwd || "");
    if (!key) {
      return { skills: [], errors: [] };
    }

    if (!forceReload && this.skillsCacheByCwd.has(key)) {
      return this.skillsCacheByCwd.get(key);
    }

    const response = await this.runtime.listSkills({
      cwds: [key],
      forceReload,
    });
    const entries = skillsEntriesFromResponse(response);
    const row = entries.find((item) => String(item?.cwd || "") === key) || entries[0] || {};
    const payload = {
      skills: Array.isArray(row?.skills) ? row.skills : [],
      errors: Array.isArray(row?.errors) ? row.errors : [],
    };
    this.skillsCacheByCwd.set(key, payload);
    return payload;
  }

  #touchSkillsContext(binding, cwd, skills) {
    const compact = (Array.isArray(skills) ? skills : []).slice(0, 200).map((skill) => ({
      name: skill?.name || "",
      path: skill?.path || "",
      enabled: Boolean(skill?.enabled),
      scope: skill?.scope || "",
    }));
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        skillsContext: {
          cwd,
          count: compact.length,
          updatedAt: new Date().toISOString(),
          skills: compact,
        },
      },
    });
  }

  async #resolveSkillByName(binding, cwd, name, { forceReload = false } = {}) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const { skills } = await this.#loadSkillsForCwd(cwd, { forceReload });
    this.#touchSkillsContext(binding, cwd, skills);
    return skills.find((skill) => String(skill?.name || "").toLowerCase() === needle) || null;
  }

  async #buildTurnInput(adapter, context, binding, prompt, cwd) {
    const text = String(prompt || "").trim();
    const baseInput = [{ type: "text", text }];

    const skillName = extractSkillNameFromPrompt(text);
    if (!skillName) {
      return baseInput;
    }

    const skill = await this.#resolveSkillByName(binding, cwd, skillName);
    if (!skill?.path) {
      return baseInput;
    }

    await this.#sendMessage(adapter, context, `Auto-attached skill: ${skill.name}`);
    return [
      { type: "text", text },
      { type: "skill", name: skill.name, path: skill.path },
    ];
  }

  async #startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides = {}) {
    let threadId = binding.threadId;
    if (!threadId) {
      threadId = await this.#startFreshThreadForBinding(binding, bKey);
    }

    if (!threadId) {
      await this.#sendMessage(adapter, context, "Failed to obtain a thread id.");
      return null;
    }

    const cwd = overrides.cwd || binding.workingDir;
    const input = overrides.input || await this.#buildTurnInput(adapter, context, binding, prompt, cwd);
    const baseParams = {
      input,
      approvalPolicy: binding.policyProfile.approvalMode,
      cwd,
      model: overrides.model ?? binding.policyProfile.model ?? null,
      effort: overrides.effort ?? binding.policyProfile.reasoningEffort ?? null,
      collaborationMode: overrides.collaborationMode ?? binding.policyProfile.collaborationMode ?? null,
    };

    return startTurnWithRecovery({
      threadId,
      baseParams,
      startTurn: (params) => this.runtime.startTurn(params),
      resumeThread: (candidateThreadId) => this.runtime.resumeThread(candidateThreadId),
      startFreshThread: async () => {
        this.logger.warn(`stale thread detected for ${bKey}: ${threadId}`);
        this.threadToBinding.delete(threadId);
        await this.#sendMessage(adapter, context, `Thread expired: ${threadId}. Starting a new thread...`);
        const freshThreadId = await this.#startFreshThreadForBinding(binding, bKey);
        if (!freshThreadId) {
          await this.#sendMessage(adapter, context, "Failed to recover thread. Run /new and retry.");
          return null;
        }
        return freshThreadId;
      },
      isThreadNotFoundError,
      onRecovered: async ({ threadId: recoveredThreadId, resumeResponse }) => {
        this.logger.warn(`thread not found on turn/start for ${bKey}: ${recoveredThreadId}; attempting resume`);
        this.threadToBinding.set(recoveredThreadId, bKey);
        let resumedCwd = extractThreadCwd(resumeResponse);
        if (!resumedCwd) {
          resumedCwd = await this.#resolveThreadCwd(recoveredThreadId);
        }
        const updated = this.store.upsertBinding({
          ...binding,
          threadId: recoveredThreadId,
          ...(resumedCwd ? { workingDir: resumedCwd } : {}),
        });
        Object.assign(binding, updated);
        await this.#sendMessage(
          adapter,
          context,
          resumedCwd
            ? `Restored thread context: ${recoveredThreadId}\nWorkspace set to: ${resumedCwd}`
            : `Restored thread context: ${recoveredThreadId}`
        );
      },
      onRecoveredRetryMissing: async ({ threadId: recoveredThreadId }) => {
        this.logger.warn(`recovered thread still not startable for ${bKey}: ${recoveredThreadId}`);
      },
    });
  }

  async #handleInboundSafe(context) {
    try {
      await this.#handleInbound(context);
    } catch (error) {
      const adapter = this.#getAdapter(context.channel);
      if (adapter) {
        await this.#sendMessage(adapter, context, formatRuntimeError(error));
      }
      this.logger.error(`${context.channel} inbound failed`, error);
    }
  }

  async #handleInbound(context) {
    await this.inboundCommands.handle(context);
  }

  async #handleRuntimeNotification(notification) {
    await this.turnEventRouter.handle(notification);
  }

  async #handleServerRequest(serverRequest) {
    if (!supportedApprovalMethod(serverRequest.method)) {
      this.logger.warn(`unhandled server request method: ${serverRequest.method}`);
      return;
    }

    const threadId = detectThreadId(serverRequest.params);
    const bKey = threadId ? this.threadToBinding.get(threadId) : null;
    if (!bKey) {
      this.logger.warn(`no binding found for server request on thread ${threadId || "unknown"}`);
      await this.runtime.respondServerRequest(serverRequest.id, { decision: "decline" });
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const binding = this.store.getBinding(channel, chatId);
    const adapter = this.#getAdapter(channel);

    if (!binding || !adapter) {
      await this.runtime.respondServerRequest(serverRequest.id, { decision: "decline" });
      return;
    }

    const created = this.approvalBroker.create({
      serverRequest,
      binding,
      autoApprove: Boolean(binding.policyProfile?.autoApprove),
    });

    if (created.autoResolved) {
      return;
    }

    this.store.createPendingApproval({
      ...created.record,
      summary: serverRequest.params?.reason || serverRequest.params?.command || "approval required",
    });

    this.store.appendAudit({
      type: "approval_requested",
      localRequestId: created.record.localRequestId,
      method: serverRequest.method,
      channel,
      chatId,
    });

    const turnId = detectTurnId(serverRequest.params);
    const approvalSummary = serverRequest.params?.reason || serverRequest.params?.command || "";

    await this.#sendApprovalPrompt(
      adapter,
      { channel, chatId, userId: binding.userId || "", turnId },
      {
        localRequestId: created.record.localRequestId,
        kind: serverRequest.method,
        summary: approvalSummary,
      }
    );
  }
}
