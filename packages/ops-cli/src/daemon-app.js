import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { AppServerRuntime } from "../../core-runtime/src/index.js";
import {
  TelegramAdapter,
  DiscordAdapter,
  parseIncomingCommand,
} from "../../im-gateway/src/index.js";
import { StateStore } from "../../state-store/src/index.js";
import { ApprovalBroker } from "./approval-broker.js";
import { DesktopSyncWorkaround } from "./desktop-sync.js";
import { commandManual } from "./help-manual.js";
import { createLogger } from "./logger.js";
import { detectDelta, detectThreadId, detectTurnId } from "./utils.js";

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

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function firstUserTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (item?.type === "userMessage") {
      const fromContent = extractTextParts(item.content);
      if (fromContent) {
        return fromContent;
      }
      if (typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }
  }
  return "";
}

function firstAgentTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (item?.type === "agentMessage") {
      if (typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
      const fromContent = extractTextParts(item.content);
      if (fromContent) {
        return fromContent;
      }
    }
  }
  return "";
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

export class DaemonApp {
  constructor({ baseDir } = {}) {
    this.store = new StateStore({ baseDir });
    this.config = this.store.readConfig();

    this.logger = createLogger({
      filePath: path.join(this.store.logsDir, "daemon.log"),
      level: process.env.IM_CODEX_LOG_LEVEL || "info",
    });
    this.chatHistoryPath = path.join(this.store.logsDir, "chat-history.jsonl");

    this.runtime = new AppServerRuntime({
      launchSpec: makeLaunchSpec(this.config),
      logger: this.logger,
      reconnect: true,
    });
    this.desktopSync = new DesktopSyncWorkaround({
      logger: this.logger,
      platform: process.platform,
      debounceMs: Number(process.env.IM_CODEX_DESKTOP_SYNC_DEBOUNCE_MS || 1200),
      commandTemplate: process.env.IM_CODEX_DESKTOP_SYNC_COMMAND || "",
    });

    this.approvalBroker = new ApprovalBroker({ timeoutMs: 5 * 60 * 1000 });
    this.adapters = [];

    this.threadToBinding = new Map();
    this.turnToBinding = new Map();
    this.activeTurnByBinding = new Map();
    this.threadListStateByBinding = new Map();
    this.skillsCacheByCwd = new Map();

    this.running = false;
  }

  async start() {
    this.running = true;

    for (const binding of this.store.listBindings()) {
      if (binding.threadId) {
        this.threadToBinding.set(binding.threadId, bindingKey(binding.channel, binding.chatId));
      }
    }

    this.#wireRuntimeEvents();
    this.#wireApprovalBroker();

    await this.runtime.initialize();
    this.logger.info("runtime initialized");

    await this.#startAdapters();
    this.logger.info("adapters started", this.adapters.map((adapter) => adapter.channel).join(","));

    this.store.appendAudit({ type: "daemon_started", pid: process.pid });
  }

  async stop() {
    this.running = false;
    this.approvalBroker.clearAll();
    this.desktopSync.stop();

    for (const adapter of this.adapters) {
      await adapter.stop();
    }

    await this.runtime.stop();
    this.store.appendAudit({ type: "daemon_stopped", pid: process.pid });
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
    });
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

    if (channels.telegram?.enabled && channels.telegram.botToken) {
      const telegram = new TelegramAdapter({
        token: channels.telegram.botToken,
        logger: this.logger,
      });
      telegram.registerInboundHandler((context) => {
        this.#handleInboundSafe(context).catch((error) => this.logger.error("telegram inbound failed", error));
      });
      this.adapters.push(telegram);
    }

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
        desktopSyncEnabled: Boolean(this.config.security?.desktopSyncEnabled),
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

  #isDesktopSyncEnabledForBindingKey(bKey) {
    const [channel, chatId] = String(bKey || "").split(":");
    if (!channel || !chatId) {
      return false;
    }
    const binding = this.store.getBinding(channel, chatId);
    return Boolean(binding?.policyProfile?.desktopSyncEnabled);
  }

  #scheduleDesktopSync({ threadId, bKey, reason = "" } = {}) {
    const resolvedThreadId = String(threadId || "");
    if (!resolvedThreadId) {
      return;
    }

    const resolvedBindingKey = bKey || this.threadToBinding.get(resolvedThreadId);
    if (!resolvedBindingKey) {
      return;
    }

    if (!this.#isDesktopSyncEnabledForBindingKey(resolvedBindingKey)) {
      return;
    }

    this.desktopSync.schedule({
      threadId: resolvedThreadId,
      reason,
    });
  }

  #appendChatHistory(entry) {
    try {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      });
      fs.appendFileSync(this.chatHistoryPath, `${line}\n`);
    } catch (error) {
      this.logger.warn(`failed to append chat history: ${error.message}`);
    }
  }

  async #sendMessage(adapter, context, text) {
    this.#appendChatHistory({
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

  async #sendStreamingDelta(adapter, context, delta) {
    this.#appendChatHistory({
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
    this.#appendChatHistory({
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

  async #renderRecentThreadHistory(threadId, { turns = 3, textLimit = 260 } = {}) {
    try {
      const read = await this.runtime.readThread({ threadId, includeTurns: true });
      const allTurns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
      const recentTurns = allTurns.slice(-turns);
      if (!recentTurns.length) {
        return "";
      }

      const lines = [];
      for (const turn of recentTurns) {
        const userText = singleLine(firstUserTextFromTurn(turn)).slice(0, textLimit);
        const agentText = singleLine(firstAgentTextFromTurn(turn)).slice(0, textLimit);
        if (userText) {
          lines.push(`You: ${userText}`);
        }
        if (agentText) {
          lines.push(`Codex: ${agentText}`);
        }
      }

      if (!lines.length) {
        return "";
      }

      return `Recent messages:\n${lines.join("\n")}`;
    } catch (error) {
      this.logger.debug(`failed to load recent thread history for ${threadId}: ${error.message}`);
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
      threadId,
      input,
      approvalPolicy: binding.policyProfile.approvalMode,
      cwd,
      model: overrides.model ?? binding.policyProfile.model ?? null,
      effort: overrides.effort ?? binding.policyProfile.reasoningEffort ?? null,
      collaborationMode: overrides.collaborationMode ?? binding.policyProfile.collaborationMode ?? null,
    };

    try {
      const turnResponse = await this.runtime.startTurn(baseParams);
      return { threadId, turnResponse };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }

      this.logger.warn(`stale thread detected for ${bKey}: ${threadId}`);
      this.threadToBinding.delete(threadId);
      await this.#sendMessage(adapter, context, `Thread expired: ${threadId}. Starting a new thread...`);

      threadId = await this.#startFreshThreadForBinding(binding, bKey);
      if (!threadId) {
        await this.#sendMessage(adapter, context, "Failed to recover thread. Run /new and retry.");
        return null;
      }

      const turnResponse = await this.runtime.startTurn({ ...baseParams, threadId });
      return { threadId, turnResponse };
    }
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
    const adapter = this.#getAdapter(context.channel);
    if (!adapter) {
      return;
    }

    const binding = this.#ensureBinding(context);
    const command = parseIncomingCommand(context.text);
    const bKey = bindingKey(binding.channel, binding.chatId);

    this.#appendChatHistory({
      direction: "inbound",
      type: "message",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      userName: context.userName || "",
      text: String(context.text || ""),
      commandType: command.type,
    });

    if (command.type === "empty") {
      return;
    }

    if (command.type === "status") {
      const pending = this.approvalBroker.listPending().length;
      const active = this.activeTurnByBinding.get(bKey);
      await this.#sendMessage(adapter, context, [
        `Binding: ${bKey}`,
        `Thread: ${binding.threadId || "none"}`,
        `Workspace: ${binding.workingDir}`,
        `Model: ${binding.policyProfile?.model || "runtime default"}`,
        `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
        `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
        `Active turn: ${active || "none"}`,
        `Pending approvals: ${pending}`,
      ].join("\n"));
      return;
    }

    if (command.type === "help") {
      await this.#sendMessage(adapter, context, commandManual(command.topic));
      return;
    }

    if (!this.#isAuthorized(binding, context)) {
      await this.#sendMessage(
        adapter,
        context,
        "Unauthorized. Your user ID is not in the binding/channel allowlist."
      );
      return;
    }

    const runInterrupt = async () => {
      const turnId = this.activeTurnByBinding.get(bKey);
      if (!binding.threadId || !turnId) {
        await this.#sendMessage(adapter, context, "No active turn to interrupt.");
        return true;
      }
      await this.runtime.interruptTurn({ threadId: binding.threadId, turnId });
      await this.#sendMessage(adapter, context, `Interrupt requested for turn ${turnId}.`);
      return true;
    };

    const runResume = async (threadId) => {
      if (!threadId) {
        await this.#sendMessage(adapter, context, "Usage: /resume <threadId>");
        return true;
      }
      let resumeResponse = null;
      try {
        resumeResponse = await this.runtime.resumeThread(threadId);
      } catch (error) {
        if (isThreadNotFoundError(error)) {
          await this.#sendMessage(adapter, context, `Thread not found: ${threadId}. Use /new to start a fresh thread.`);
          return true;
        }
        throw error;
      }

      this.threadToBinding.set(threadId, bKey);
      let resumedCwd = extractThreadCwd(resumeResponse);
      if (!resumedCwd) {
        resumedCwd = await this.#resolveThreadCwd(threadId);
      }
      const updated = this.store.upsertBinding({
        ...binding,
        threadId,
        ...(resumedCwd ? { workingDir: resumedCwd } : {}),
      });
      if (resumedCwd) {
        await this.#sendMessage(adapter, context, `Resumed thread: ${threadId}\nWorkspace set to: ${resumedCwd}`);
      } else {
        await this.#sendMessage(adapter, context, `Resumed thread: ${threadId}`);
      }
      const recent = await this.#renderRecentThreadHistory(threadId, { turns: 3 });
      if (recent) {
        await this.#sendMessage(adapter, context, recent);
      }
      Object.assign(binding, updated);
      return true;
    };

    const runAsk = async (prompt, overrides = {}) => {
      if (!prompt) {
        await this.#sendMessage(adapter, context, "Usage: /ask <prompt>");
        return true;
      }
      const started = await this.#startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides);
      if (!started) {
        return true;
      }
      const { threadId, turnResponse } = started;
      const turnId = turnIdFromResponse(turnResponse);
      if (turnId) {
        this.turnToBinding.set(turnId, bKey);
        this.activeTurnByBinding.set(bKey, turnId);
      }
      this.#scheduleDesktopSync({ threadId, bKey, reason: "turn started" });
      await this.#sendMessage(adapter, context, `Turn started: ${turnId || "unknown"}`);
      this.store.appendAudit({
        type: "turn_started",
        channel: context.channel,
        chatId: context.chatId,
        threadId,
        turnId,
      });
      return true;
    };

    if (command.type === "new") {
      const threadId = await this.#startFreshThreadForBinding(binding, bKey);
      await this.#sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
      return;
    }

    if (command.type === "resume") {
      await runResume(command.threadId);
      return;
    }

    if (command.type === "interrupt") {
      await runInterrupt();
      return;
    }

    if (command.type === "turn") {
      const action = command.action || "";
      const { positional, options } = parseArgsAndOptions(command.args);
      if (action === "ask") {
        let turnCwd = binding.workingDir;
        if (options.cwd) {
          const resolved = resolveWorkspacePath(options.cwd, binding.workingDir);
          if (resolved.error) {
            await this.#sendMessage(adapter, context, resolved.error);
            return;
          }
          turnCwd = resolved.value;
        }
        await runAsk(positional.join(" ").trim(), {
          model: options.model || null,
          effort: options.effort || null,
          collaborationMode: options.mode || null,
          cwd: turnCwd,
        });
        return;
      }
      if (action === "steer") {
        const activeTurnId = this.activeTurnByBinding.get(bKey);
        if (!binding.threadId || !activeTurnId) {
          await this.#sendMessage(adapter, context, "No active turn to steer.");
          return;
        }
        const prompt = positional.join(" ").trim();
        if (!prompt) {
          await this.#sendMessage(adapter, context, "Usage: /turn steer <prompt>");
          return;
        }
        await this.runtime.steerTurn({
          threadId: binding.threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: "text", text: prompt }],
        });
        await this.#sendMessage(adapter, context, `Steer accepted for turn ${activeTurnId}.`);
        return;
      }
      if (action === "interrupt") {
        await runInterrupt();
        return;
      }
      if (action === "review") {
        if (!binding.threadId) {
          await this.#sendMessage(adapter, context, "No active thread. Start one with /new first.");
          return;
        }
        const delivery = options.delivery || (toBoolean(options.detached, false) ? "detached" : "inline");
        const targetKey = String(options.target || positional[0] || "uncommitted").toLowerCase();
        let target = { type: "uncommittedChanges" };
        if (["base", "basebranch"].includes(targetKey)) {
          const branch = options.branch || positional[1];
          if (!branch) {
            await this.#sendMessage(adapter, context, "Usage: /turn review base <branch> [--delivery inline|detached]");
            return;
          }
          target = { type: "baseBranch", branch };
        } else if (targetKey === "commit") {
          const sha = options.sha || positional[1];
          if (!sha) {
            await this.#sendMessage(adapter, context, "Usage: /turn review commit <sha> [title words]");
            return;
          }
          const title = options.title || positional.slice(2).join(" ").trim() || null;
          target = { type: "commit", sha, title };
        } else if (targetKey === "custom") {
          const instructions = (options.instructions || positional.slice(1).join(" ")).trim();
          if (!instructions) {
            await this.#sendMessage(adapter, context, "Usage: /turn review custom <instructions...>");
            return;
          }
          target = { type: "custom", instructions };
        }

        const review = await this.runtime.startReview({
          threadId: binding.threadId,
          delivery,
          target,
        });
        const reviewTurnId = turnIdFromResponse(review);
        const reviewThreadId = review?.reviewThreadId || binding.threadId;
        this.threadToBinding.set(reviewThreadId, bKey);
        if (delivery === "detached" && reviewThreadId && reviewThreadId !== binding.threadId) {
          const updated = this.store.upsertBinding({
            ...binding,
            threadId: reviewThreadId,
          });
          Object.assign(binding, updated);
        }
        if (reviewTurnId) {
          this.turnToBinding.set(reviewTurnId, bKey);
          this.activeTurnByBinding.set(bKey, reviewTurnId);
        }
        await this.#sendMessage(
          adapter,
          context,
          `Review started (${delivery}) on thread ${reviewThreadId}${reviewTurnId ? `, turn ${reviewTurnId}` : ""}.`
        );
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /turn <ask|steer|interrupt|review>");
      return;
    }

    if (command.type === "thread") {
      const action = command.action || "";
      const { positional, options } = parseArgsAndOptions(command.args);

      if (action === "start") {
        const cwdResolved = options.cwd ? resolveWorkspacePath(options.cwd, binding.workingDir) : { value: binding.workingDir };
        if (cwdResolved.error) {
          await this.#sendMessage(adapter, context, cwdResolved.error);
          return;
        }
        const response = await this.runtime.startThread({
          cwd: cwdResolved.value,
          approvalPolicy: binding.policyProfile.approvalMode,
          model: options.model || binding.policyProfile.model || null,
        });
        const threadId = threadIdFromResponse(response);
        if (threadId) {
          this.threadToBinding.set(threadId, bKey);
          const updated = this.store.upsertBinding({
            ...binding,
            threadId,
            workingDir: cwdResolved.value,
          });
          Object.assign(binding, updated);
        }
        await this.#sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
        return;
      }

      if (action === "resume") {
        await runResume(positional[0]);
        return;
      }

      if (action === "list" || action === "more") {
        const requestedLimitRaw = positional.find((item) => /^\d+$/.test(item));
        let requestedLimit = toInt(requestedLimitRaw, 10, 1, 100);
        const useAll = action === "list" && (positional.some((item) => item.toLowerCase() === "all") || toBoolean(options.all, false));
        let archived = toBoolean(options.archived, false);

        let cursor = null;
        let cwdFilter = null;
        if (action === "more") {
          const state = this.#getThreadListState(bKey);
          if (!state?.nextCursor) {
            await this.#sendMessage(adapter, context, "No next page available. Run /thread list first.");
            return;
          }
          cursor = state.nextCursor;
          cwdFilter = state.cwdFilter;
          archived = Boolean(state.archived);
          if (!requestedLimitRaw && Number.isFinite(Number(state.limit))) {
            requestedLimit = toInt(state.limit, 10, 1, 100);
          }
        } else {
          cwdFilter = useAll ? null : (options.cwd || binding.workingDir);
          cursor = options.cursor || null;
        }

        const response = await this.runtime.listThreads({
          cursor,
          limit: requestedLimit,
          archived,
          cwd: cwdFilter,
        });
        const threads = threadListFromResponse(response);
        const nextCursor = nextCursorFromResponse(response);
        this.#setThreadListState(bKey, {
          nextCursor,
          cwdFilter,
          archived,
          limit: requestedLimit,
        });

        if (!threads.length) {
          const suffix = cwdFilter ? ` for workspace: ${cwdFilter}` : "";
          await this.#sendMessage(adapter, context, `No threads found${suffix}.`);
          return;
        }

        const entries = threads.map((thread, index) => {
          const id = extractThreadId(thread) || "unknown";
          const marker = binding.threadId && id === binding.threadId ? " (current)" : "";
          const title = threadDisplayTitle(thread);
          const cwd = extractThreadCwd(thread) || "unknown";
          return `${index + 1}. ${title} | ${cwd} | ${id}${marker}`;
        });
        await this.#sendMessage(
          adapter,
          context,
          [
            "Threads:",
            entries.join("\n"),
            "",
            nextCursor ? "Use /thread more for next page." : "No more pages.",
            "Use /resume <threadId> to switch.",
          ].join("\n")
        );
        return;
      }

      if (action === "read") {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread read <threadId> [--turns true]");
          return;
        }
        const includeTurns = toBoolean(options.turns, false);
        const read = await this.runtime.readThread({ threadId, includeTurns });
        const thread = read?.thread || {};
        await this.#sendMessage(
          adapter,
          context,
          [
            `Thread: ${thread.id || threadId}`,
            `Title: ${thread.name || threadDisplayTitle(thread)}`,
            `Workspace: ${thread.cwd || "unknown"}`,
            `Status: ${thread?.status?.type || "unknown"}`,
            includeTurns ? `Turns: ${(thread.turns || []).length}` : "Turns: hidden (use --turns true)",
          ].join("\n")
        );
        return;
      }

      if (action === "fork") {
        const sourceThreadId = positional[0] || binding.threadId;
        if (!sourceThreadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread fork <threadId> [--ephemeral true]");
          return;
        }
        const forked = await this.runtime.forkThread({
          threadId: sourceThreadId,
          ephemeral: toBoolean(options.ephemeral, false),
        });
        const newThreadId = threadIdFromResponse(forked);
        if (newThreadId) {
          this.threadToBinding.set(newThreadId, bKey);
        }
        await this.#sendMessage(adapter, context, `Forked thread: ${newThreadId || "unknown"}`);
        return;
      }

      if (action === "loaded") {
        const loaded = await this.runtime.listLoadedThreads();
        const ids = Array.isArray(loaded?.data)
          ? loaded.data
          : (Array.isArray(loaded?.threadIds) ? loaded.threadIds : []);
        await this.#sendMessage(
          adapter,
          context,
          ids.length ? `Loaded threads:\n${ids.join("\n")}` : "No loaded threads."
        );
        return;
      }

      if (action === "unsubscribe") {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread unsubscribe <threadId>");
          return;
        }
        const result = await this.runtime.unsubscribeThread(threadId);
        await this.#sendMessage(adapter, context, `Unsubscribe status: ${result?.status || "ok"} (${threadId})`);
        return;
      }

      if (["archive", "unarchive", "compact", "rollback"].includes(action)) {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, `Usage: /thread ${action} <threadId> --confirm`);
          return;
        }
        if (riskyThreadActionRequiresConfirm(binding.policyProfile.approvalMode) && !toBoolean(options.confirm, false)) {
          await this.#sendMessage(
            adapter,
            context,
            `Confirmation required by approval mode. Re-run with --confirm.\nExample: /thread ${action} ${threadId} --confirm`
          );
          return;
        }

        if (action === "archive") {
          await this.runtime.archiveThread(threadId);
          if (binding.threadId === threadId) {
            const updated = this.store.upsertBinding({ ...binding, threadId: null });
            Object.assign(binding, updated);
          }
          this.threadToBinding.delete(threadId);
          await this.#sendMessage(adapter, context, `Archived thread: ${threadId}`);
          return;
        }
        if (action === "unarchive") {
          await this.runtime.unarchiveThread(threadId);
          await this.#sendMessage(adapter, context, `Unarchived thread: ${threadId}`);
          return;
        }
        if (action === "compact") {
          await this.runtime.compactThread(threadId);
          await this.#sendMessage(adapter, context, `Compaction started for thread: ${threadId}`);
          return;
        }
        if (action === "rollback") {
          const numTurns = toInt(options.turns || positional[1], 1, 1, 100);
          await this.runtime.rollbackThread({ threadId, numTurns });
          await this.#sendMessage(adapter, context, `Rolled back ${numTurns} turn(s) on thread: ${threadId}`);
          return;
        }
      }

      await this.#sendMessage(
        adapter,
        context,
        "Usage: /thread <start|resume|list|more|read|fork|loaded|unsubscribe|archive|unarchive|compact|rollback>"
      );
      return;
    }

    if (command.type === "threads") {
      const listCmd = {
        type: "thread",
        action: "list",
        args: [
          ...(command.all ? ["all"] : []),
          String(command.limit || 10),
        ],
      };
      await this.#handleInbound({
        ...context,
        text: `/thread list ${listCmd.args.join(" ")}`,
      });
      return;
    }

    if (command.type === "archive") {
      const threadId = String(command.threadId || binding.threadId || "").trim();
      if (!threadId) {
        await this.#sendMessage(adapter, context, "No thread selected. Use /archive <threadId> or /resume <threadId> first.");
        return;
      }
      await this.#handleInbound({
        ...context,
        text: `/thread archive ${threadId}`,
      });
      return;
    }

    if (command.type === "modelNs") {
      const { positional } = parseArgsAndOptions(command.args);
      if (command.action === "show") {
        await this.#sendMessage(adapter, context, [
          `Model: ${binding.policyProfile?.model || "runtime default"}`,
          `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
          `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
        ].join("\n"));
        return;
      }
      if (command.action === "list") {
        const response = await this.runtime.listModels({ includeHidden: false, limit: 30 });
        const models = modelListFromResponse(response);
        if (!models.length) {
          await this.#sendMessage(adapter, context, "No models returned by runtime.");
          return;
        }
        const lines = models.map((item) => {
          const efforts = (item.supportedReasoningEfforts || [])
            .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
            .filter(Boolean)
            .join(",");
          const hidden = Boolean(item.hidden ?? item.isHidden);
          return `${item.model || item.id}${item.isDefault ? " (default)" : ""}${hidden ? " (hidden)" : ""}${efforts ? ` | efforts:${efforts}` : ""}`;
        });
        await this.#sendMessage(adapter, context, `Models:\n${lines.join("\n")}`);
        return;
      }
      if (command.action === "set") {
        const nextModelRaw = String(positional[0] || "").trim();
        if (!nextModelRaw) {
          await this.#sendMessage(adapter, context, "Usage: /model set <modelId|default>");
          return;
        }
        const nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            model: nextModel,
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, `Model set to: ${updated.policyProfile?.model || "runtime default"}`);
        return;
      }
      if (command.action === "effort") {
        const mode = String(positional[0] || "show").toLowerCase();
        if (["show", "get"].includes(mode)) {
          await this.#sendMessage(adapter, context, `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`);
          return;
        }
        if (mode !== "set" || !positional[1]) {
          await this.#sendMessage(adapter, context, "Usage: /model effort set <low|medium|high|xhigh|default>");
          return;
        }
        const raw = String(positional[1]).trim().toLowerCase();
        const effort = ["default", "auto"].includes(raw) ? null : raw;
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            reasoningEffort: effort,
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, `Effort set to: ${updated.policyProfile?.reasoningEffort || "runtime default"}`);
        return;
      }
      if (command.action === "mode") {
        const mode = String(positional[0] || "show").toLowerCase();
        if (mode === "list") {
          const response = await this.runtime.listCollaborationModes();
          const modes = collaborationModesFromResponse(response);
          const lines = modes.map((item) => `${item.mode || item.name || "unknown"}${item.model ? ` | model:${item.model}` : ""}`);
          await this.#sendMessage(adapter, context, lines.length ? `Modes:\n${lines.join("\n")}` : "No collaboration modes returned.");
          return;
        }
        if (["show", "get"].includes(mode)) {
          await this.#sendMessage(adapter, context, `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`);
          return;
        }
        if (mode !== "set" || !positional[1]) {
          await this.#sendMessage(adapter, context, "Usage: /model mode <list|show|set <mode|default>>");
          return;
        }
        const raw = String(positional[1]).trim();
        const collaborationMode = ["default", "auto"].includes(raw.toLowerCase()) ? null : raw;
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            collaborationMode,
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, `Mode set to: ${updated.policyProfile?.collaborationMode || "runtime default"}`);
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /model <show|list|set|effort|mode>");
      return;
    }

    if (command.type === "skills") {
      const action = command.action || "";
      const { positional, options } = parseArgsAndOptions(command.args);
      const cwdResolved = options.cwd ? resolveWorkspacePath(options.cwd, binding.workingDir) : { value: binding.workingDir };
      if (cwdResolved.error) {
        await this.#sendMessage(adapter, context, cwdResolved.error);
        return;
      }
      const skillsCwd = cwdResolved.value;

      if (action === "list" || action === "reload") {
        const forceReload = action === "reload" || toBoolean(options.reload, false) || toBoolean(options.forceReload, false);
        const payload = await this.#loadSkillsForCwd(skillsCwd, { forceReload });
        this.#touchSkillsContext(binding, skillsCwd, payload.skills);
        if (!payload.skills.length) {
          await this.#sendMessage(adapter, context, `No skills found for ${skillsCwd}.`);
          return;
        }
        const limit = toInt(options.limit, 20, 1, 200);
        const lines = payload.skills.slice(0, limit).map((skill) => (
          `${skill.name}${skill.enabled === false ? " (disabled)" : ""} | ${skill.scope || "user"} | ${skill.path || ""}`
        ));
        await this.#sendMessage(adapter, context, `Skills (${skillsCwd}):\n${lines.join("\n")}`);
        return;
      }

      if (action === "use") {
        const skillName = positional[0];
        const prompt = positional.slice(1).join(" ").trim();
        if (!skillName || !prompt) {
          await this.#sendMessage(adapter, context, "Usage: /skills use <skill-name> <prompt...>");
          return;
        }
        const skill = await this.#resolveSkillByName(binding, skillsCwd, skillName, { forceReload: false });
        if (!skill?.path) {
          await this.#sendMessage(adapter, context, `Skill not found: ${skillName}. Use /skills list first.`);
          return;
        }
        const text = prompt.includes(`$${skill.name}`) ? prompt : `$${skill.name} ${prompt}`;
        await runAsk(text, {
          cwd: skillsCwd,
          model: options.model || null,
          effort: options.effort || null,
          collaborationMode: options.mode || null,
          input: [
            { type: "text", text },
            { type: "skill", name: skill.name, path: skill.path },
          ],
        });
        return;
      }

      if (action === "enable" || action === "disable") {
        const ref = positional[0];
        if (!ref) {
          await this.#sendMessage(adapter, context, "Usage: /skills enable|disable <skill-name-or-path>");
          return;
        }
        const enabled = action === "enable";
        let skillPath = ref;
        if (!ref.includes("/") && !ref.includes("\\")) {
          const skill = await this.#resolveSkillByName(binding, skillsCwd, ref, { forceReload: false });
          if (!skill?.path) {
            await this.#sendMessage(adapter, context, `Skill not found: ${ref}. Use /skills list first.`);
            return;
          }
          skillPath = skill.path;
        }
        await this.runtime.writeSkillConfig({ path: skillPath, enabled });
        this.skillsCacheByCwd.delete(skillsCwd);
        await this.#sendMessage(adapter, context, `${enabled ? "Enabled" : "Disabled"} skill: ${skillPath}`);
        return;
      }

      await this.#sendMessage(adapter, context, "Usage: /skills <list|use|enable|disable|reload>");
      return;
    }

    if (command.type === "model") {
      const nextModelRaw = String(command.value || "").trim();
      if (!nextModelRaw) {
        await this.#sendMessage(adapter, context, `Model: ${binding.policyProfile?.model || "runtime default"}`);
        return;
      }

      const nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
      const updated = this.store.upsertBinding({
        ...binding,
        policyProfile: {
          ...binding.policyProfile,
          model: nextModel,
        },
      });
      await this.#sendMessage(adapter, context, `Model set to: ${updated.policyProfile?.model || "runtime default"}`);
      return;
    }

    if (command.type === "approve") {
      if (!command.requestId || !["allow", "deny"].includes(command.decision)) {
        await this.#sendMessage(adapter, context, "Usage: /approve <requestId> <allow|deny> [payload]");
        return;
      }

      const resolution = this.approvalBroker.resolve(command.requestId, {
        decision: command.decision,
        payload: command.payload,
        actor: context.userId,
      });

      if (!resolution) {
        await this.#sendMessage(adapter, context, `Unknown or expired approval request: ${command.requestId}`);
      }
      return;
    }

    if (command.type === "cwd") {
      const resolved = resolveWorkspacePath(command.path, binding.workingDir);
      if (resolved.error) {
        await this.#sendMessage(adapter, context, resolved.error);
        return;
      }

      const updated = this.store.upsertBinding({
        ...binding,
        workingDir: resolved.value,
      });
      await this.#sendMessage(
        adapter,
        context,
        `Workspace set to: ${updated.workingDir}`
      );
      return;
    }

    if (command.type === "ask") {
      await runAsk(command.prompt);
      return;
    }

    await this.#sendMessage(
      adapter,
      context,
      "Unknown command. Use /help to see all commands and examples."
    );
  }

  async #handleRuntimeNotification(notification) {
    const { method, params } = notification;

    if (!method) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const threadId = detectThreadId(params);
      const turnId = detectTurnId(params);
      const delta = detectDelta(params);
      if (!delta) {
        return;
      }

      const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
      if (!bKey) {
        return;
      }

      const [channel, chatId] = bKey.split(":");
      const adapter = this.#getAdapter(channel);
      if (!adapter) {
        return;
      }

      this.#scheduleDesktopSync({ threadId, bKey, reason: "turn streaming delta" });
      await this.#sendStreamingDelta(adapter, { channel, chatId, turnId }, delta);
      return;
    }

    if (method === "turn/started") {
      const threadId = detectThreadId(params);
      const turnId = detectTurnId(params);
      const bKey = this.threadToBinding.get(threadId);
      if (bKey && turnId) {
        this.turnToBinding.set(turnId, bKey);
        this.activeTurnByBinding.set(bKey, turnId);
      }
      return;
    }

    if (method === "turn/completed") {
      const threadId = detectThreadId(params);
      const turnId = detectTurnId(params);
      const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
      if (!bKey) {
        return;
      }

      const [channel, chatId] = bKey.split(":");
      const adapter = this.#getAdapter(channel);
      if (adapter) {
        const status = params?.turn?.status || "completed";
        await this.#sendMessage(adapter, { channel, chatId, turnId }, `Turn completed (${status}).`);
      }
      this.#scheduleDesktopSync({ threadId, bKey, reason: "turn completed" });

      this.turnToBinding.delete(turnId);
      this.activeTurnByBinding.delete(bKey);
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
        }
      }
      this.store.appendAudit({ type: "thread_closed", threadId: threadId || null });
      return;
    }

    if (method === "thread/archived") {
      const threadId = detectThreadId(params) || params?.threadId;
      if (threadId) {
        const bKey = this.threadToBinding.get(threadId);
        this.threadToBinding.delete(threadId);
        if (bKey) {
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
      return;
    }

    if (method === "thread/unarchived") {
      const threadId = detectThreadId(params) || params?.threadId;
      this.store.appendAudit({ type: "thread_unarchived", threadId: threadId || null });
      return;
    }

    if (method === "skills/changed") {
      this.skillsCacheByCwd.clear();
      this.store.appendAudit({ type: "skills_changed" });
      return;
    }

    if (method === "error") {
      const threadId = detectThreadId(params);
      const turnId = detectTurnId(params);
      const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
      if (!bKey) {
        return;
      }
      const [channel, chatId] = bKey.split(":");
      const adapter = this.#getAdapter(channel);
      if (!adapter) {
        return;
      }
      await this.#sendMessage(adapter, { channel, chatId, turnId }, `Runtime error: ${params?.error?.message || "unknown"}`);
    }
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

    await this.#sendApprovalPrompt(
      adapter,
      { channel, chatId, userId: binding.userId || "", turnId: detectTurnId(serverRequest.params) },
      {
        localRequestId: created.record.localRequestId,
        kind: serverRequest.method,
        summary: serverRequest.params?.reason || serverRequest.params?.command || "",
      }
    );
  }
}
