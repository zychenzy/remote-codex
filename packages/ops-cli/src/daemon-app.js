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

export class DaemonApp {
  constructor({ baseDir } = {}) {
    this.store = new StateStore({ baseDir });
    this.config = this.store.readConfig();

    this.logger = createLogger({
      filePath: path.join(this.store.logsDir, "daemon.log"),
      level: process.env.IM_CODEX_LOG_LEVEL || "info",
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
        await adapter.sendMessage(context, text);
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
        this.#handleInbound(context).catch((error) => this.logger.error("telegram inbound failed", error));
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
        this.#handleInbound(context).catch((error) => this.logger.error("discord inbound failed", error));
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

  async #handleInbound(context) {
    const adapter = this.#getAdapter(context.channel);
    if (!adapter) {
      return;
    }

    const binding = this.#ensureBinding(context);
    const command = parseIncomingCommand(context.text);
    const bKey = bindingKey(binding.channel, binding.chatId);

    if (command.type === "empty") {
      return;
    }

    if (command.type === "status") {
      const pending = this.approvalBroker.listPending().length;
      const active = this.activeTurnByBinding.get(bKey);
      await adapter.sendMessage(context, [
        `Binding: ${bKey}`,
        `Thread: ${binding.threadId || "none"}`,
        `Workspace: ${binding.workingDir}`,
        `Active turn: ${active || "none"}`,
        `Pending approvals: ${pending}`,
      ].join("\n"));
      return;
    }

    if (!this.#isAuthorized(binding, context)) {
      await adapter.sendMessage(
        context,
        "Unauthorized. Your user ID is not in the binding/channel allowlist."
      );
      return;
    }

    if (command.type === "new") {
      const response = await this.runtime.startThread({
        cwd: binding.workingDir,
        approvalPolicy: binding.policyProfile.approvalMode,
      });
      const threadId = threadIdFromResponse(response);
      if (threadId) {
        this.threadToBinding.set(threadId, bKey);
        this.store.setBindingThread(binding.channel, binding.chatId, threadId);
      }
      await adapter.sendMessage(context, `Started thread: ${threadId || "unknown"}`);
      return;
    }

    if (command.type === "resume") {
      if (!command.threadId) {
        await adapter.sendMessage(context, "Usage: /resume <threadId>");
        return;
      }
      await this.runtime.resumeThread(command.threadId);
      this.threadToBinding.set(command.threadId, bKey);
      this.store.setBindingThread(binding.channel, binding.chatId, command.threadId);
      await adapter.sendMessage(context, `Resumed thread: ${command.threadId}`);
      return;
    }

    if (command.type === "interrupt") {
      const turnId = this.activeTurnByBinding.get(bKey);
      if (!binding.threadId || !turnId) {
        await adapter.sendMessage(context, "No active turn to interrupt.");
        return;
      }
      await this.runtime.interruptTurn({ threadId: binding.threadId, turnId });
      await adapter.sendMessage(context, `Interrupt requested for turn ${turnId}.`);
      return;
    }

    if (command.type === "approve") {
      if (!command.requestId || !["allow", "deny"].includes(command.decision)) {
        await adapter.sendMessage(context, "Usage: /approve <requestId> <allow|deny> [payload]");
        return;
      }

      const resolution = this.approvalBroker.resolve(command.requestId, {
        decision: command.decision,
        payload: command.payload,
        actor: context.userId,
      });

      if (!resolution) {
        await adapter.sendMessage(context, `Unknown or expired approval request: ${command.requestId}`);
      }
      return;
    }

    if (command.type === "cwd") {
      const resolved = resolveWorkspacePath(command.path, binding.workingDir);
      if (resolved.error) {
        await adapter.sendMessage(context, resolved.error);
        return;
      }

      const updated = this.store.upsertBinding({
        ...binding,
        workingDir: resolved.value,
      });
      await adapter.sendMessage(
        context,
        `Workspace set to: ${updated.workingDir}`
      );
      return;
    }

    if (command.type === "ask") {
      if (!command.prompt) {
        await adapter.sendMessage(context, "Usage: /ask <prompt>");
        return;
      }

      let threadId = binding.threadId;
      if (!threadId) {
        const thread = await this.runtime.startThread({
          cwd: binding.workingDir,
          approvalPolicy: binding.policyProfile.approvalMode,
        });
        threadId = threadIdFromResponse(thread);
        if (threadId) {
          this.threadToBinding.set(threadId, bKey);
          this.store.setBindingThread(binding.channel, binding.chatId, threadId);
        }
      }

      if (!threadId) {
        await adapter.sendMessage(context, "Failed to obtain a thread id.");
        return;
      }

      const turnResponse = await this.runtime.startTurn({
        threadId,
        input: [{ type: "text", text: command.prompt }],
        approvalPolicy: binding.policyProfile.approvalMode,
        cwd: binding.workingDir,
      });
      const turnId = turnIdFromResponse(turnResponse);
      if (turnId) {
        this.turnToBinding.set(turnId, bKey);
        this.activeTurnByBinding.set(bKey, turnId);
      }
      await adapter.sendMessage(context, `Turn started: ${turnId || "unknown"}`);
      this.store.appendAudit({
        type: "turn_started",
        channel: context.channel,
        chatId: context.chatId,
        threadId,
        turnId,
      });
      return;
    }

    await adapter.sendMessage(
      context,
      "Supported commands: /new, /resume <id>, /ask <prompt>, /cwd <path>, /interrupt, /approve <id> <allow|deny>, /status"
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

      await adapter.sendStreamingDelta({ channel, chatId, turnId }, delta);
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
        await adapter.sendMessage({ channel, chatId, turnId }, `Turn completed (${status}).`);
      }

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
      await adapter.sendMessage({ channel, chatId, turnId }, `Runtime error: ${params?.error?.message || "unknown"}`);
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

    await adapter.sendApprovalPrompt(
      { channel, chatId, userId: binding.userId || "", turnId: detectTurnId(serverRequest.params) },
      {
        localRequestId: created.record.localRequestId,
        kind: serverRequest.method,
        summary: serverRequest.params?.reason || serverRequest.params?.command || "",
      }
    );
  }
}
