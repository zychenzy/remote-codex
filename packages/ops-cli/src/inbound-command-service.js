import { commandManual } from "./help-manual.js";

export class InboundCommandService {
  constructor({
    parseIncomingCommand,
    handleModelAndSkillsCommand,
    getRuntime,
    getStore,
    getApprovalBroker,
    getOutputPolicy,
    threadToBinding,
    turnToBinding,
    activeTurnByBinding,
    suppressedTurnIds,
    getAdapter,
    ensureBinding,
    appendChatHistory,
    sendMessage,
    isAuthorized,
    startTurnWithRecovery,
    startFreshThreadForBinding,
    sendThreadHistory,
    setThreadListState,
    getThreadListState,
    resolveThreadCwd,
    loadSkillsForCwd,
    touchSkillsContext,
    resolveSkillByName,
    clearSkillCache,
    bindingKeyFn,
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
  } = {}) {
    this.parseIncomingCommand = parseIncomingCommand;
    this.handleModelAndSkillsCommand = handleModelAndSkillsCommand;
    this.getRuntime = getRuntime;
    this.getStore = getStore;
    this.getApprovalBroker = getApprovalBroker;
    this.getOutputPolicy = getOutputPolicy;
    this.threadToBinding = threadToBinding;
    this.turnToBinding = turnToBinding;
    this.activeTurnByBinding = activeTurnByBinding;
    this.suppressedTurnIds = suppressedTurnIds;
    this.getAdapter = getAdapter;
    this.ensureBinding = ensureBinding;
    this.appendChatHistory = appendChatHistory;
    this.sendMessage = sendMessage;
    this.isAuthorized = isAuthorized;
    this.startTurnWithRecovery = startTurnWithRecovery;
    this.startFreshThreadForBinding = startFreshThreadForBinding;
    this.sendThreadHistory = sendThreadHistory;
    this.setThreadListState = setThreadListState;
    this.getThreadListState = getThreadListState;
    this.resolveThreadCwd = resolveThreadCwd;
    this.loadSkillsForCwd = loadSkillsForCwd;
    this.touchSkillsContext = touchSkillsContext;
    this.resolveSkillByName = resolveSkillByName;
    this.clearSkillCache = clearSkillCache;
    this.bindingKeyFn = bindingKeyFn;
    this.parseArgsAndOptions = parseArgsAndOptions;
    this.resolveWorkspacePath = resolveWorkspacePath;
    this.toBoolean = toBoolean;
    this.toInt = toInt;
    this.isThreadNotFoundError = isThreadNotFoundError;
    this.riskyThreadActionRequiresConfirm = riskyThreadActionRequiresConfirm;
    this.threadIdFromResponse = threadIdFromResponse;
    this.turnIdFromResponse = turnIdFromResponse;
    this.threadListFromResponse = threadListFromResponse;
    this.nextCursorFromResponse = nextCursorFromResponse;
    this.extractThreadId = extractThreadId;
    this.threadDisplayTitle = threadDisplayTitle;
    this.extractThreadCwd = extractThreadCwd;
    this.modelListFromResponse = modelListFromResponse;
    this.collaborationModesFromResponse = collaborationModesFromResponse;
  }

  async handle(context) {
    const runtime = this.getRuntime();
    const store = this.getStore();
    const approvalBroker = this.getApprovalBroker();
    const outputPolicy = this.getOutputPolicy();

    const adapter = this.getAdapter(context.channel);
    if (!adapter) {
      return;
    }

    const binding = this.ensureBinding(context);
    const command = this.parseIncomingCommand(context.text);
    const bKey = this.bindingKeyFn(binding.channel, binding.chatId);

    this.appendChatHistory({
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
      const pending = approvalBroker.listPending().length;
      const active = this.activeTurnByBinding.get(bKey);
      await this.sendMessage(adapter, context, [
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
      await this.sendMessage(adapter, context, commandManual(command.topic));
      return;
    }

    if (!this.isAuthorized(binding, context)) {
      await this.sendMessage(
        adapter,
        context,
        "Unauthorized. Your user ID is not in the binding/channel allowlist."
      );
      return;
    }

    const runInterrupt = async () => {
      const turnId = this.activeTurnByBinding.get(bKey);
      if (!binding.threadId || !turnId) {
        await this.sendMessage(adapter, context, "No active turn to interrupt.");
        return true;
      }
      await runtime.interruptTurn({ threadId: binding.threadId, turnId });
      this.suppressedTurnIds.add(String(turnId));
      this.activeTurnByBinding.delete(bKey);
      await this.sendMessage(adapter, context, `Interrupt requested for turn ${turnId}.`);
      return true;
    };

    const runResume = async (threadId) => {
      if (!threadId) {
        await this.sendMessage(adapter, context, "Usage: /resume <threadId>");
        return true;
      }
      let resumeResponse = null;
      try {
        resumeResponse = await runtime.resumeThread(threadId);
      } catch (error) {
        if (this.isThreadNotFoundError(error)) {
          await this.sendMessage(adapter, context, `Thread not found: ${threadId}. Use /new to start a fresh thread.`);
          return true;
        }
        throw error;
      }

      this.threadToBinding.set(threadId, bKey);
      let resumedCwd = this.extractThreadCwd(resumeResponse);
      if (!resumedCwd) {
        resumedCwd = await this.resolveThreadCwd(threadId);
      }
      const updated = store.upsertBinding({
        ...binding,
        threadId,
        ...(resumedCwd ? { workingDir: resumedCwd } : {}),
      });
      if (resumedCwd) {
        await this.sendMessage(adapter, context, `Resumed thread: ${threadId}\nWorkspace set to: ${resumedCwd}`);
      } else {
        await this.sendMessage(adapter, context, `Resumed thread: ${threadId}`);
      }
      await this.sendThreadHistory(adapter, context, threadId, {
        turns: outputPolicy.resumeHistoryTurns,
      });
      Object.assign(binding, updated);
      return true;
    };

    const runAsk = async (prompt, overrides = {}) => {
      if (!prompt) {
        await this.sendMessage(adapter, context, "Usage: /ask <prompt>");
        return true;
      }
      const started = await this.startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides);
      if (!started) {
        return true;
      }
      const { threadId, turnResponse } = started;
      const turnId = this.turnIdFromResponse(turnResponse);
      if (turnId) {
        this.turnToBinding.set(turnId, bKey);
        this.activeTurnByBinding.set(bKey, turnId);
      }
      if (adapter.channel !== "discord") {
        await this.sendMessage(adapter, context, `Turn started: ${turnId || "unknown"}`);
      }
      store.appendAudit({
        type: "turn_started",
        channel: context.channel,
        chatId: context.chatId,
        threadId,
        turnId,
      });
      return true;
    };

    if (command.type === "new") {
      const threadId = await this.startFreshThreadForBinding(binding, bKey);
      await this.sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
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
      const { positional, options } = this.parseArgsAndOptions(command.args);
      if (action === "ask") {
        let turnCwd = binding.workingDir;
        if (options.cwd) {
          const resolved = this.resolveWorkspacePath(options.cwd, binding.workingDir);
          if (resolved.error) {
            await this.sendMessage(adapter, context, resolved.error);
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
          await this.sendMessage(adapter, context, "No active turn to steer.");
          return;
        }
        const prompt = positional.join(" ").trim();
        if (!prompt) {
          await this.sendMessage(adapter, context, "Usage: /turn steer <prompt>");
          return;
        }
        await runtime.steerTurn({
          threadId: binding.threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: "text", text: prompt }],
        });
        await this.sendMessage(adapter, context, `Steer accepted for turn ${activeTurnId}.`);
        return;
      }
      if (action === "interrupt") {
        await runInterrupt();
        return;
      }
      if (action === "review") {
        if (!binding.threadId) {
          await this.sendMessage(adapter, context, "No active thread. Start one with /new first.");
          return;
        }
        const delivery = options.delivery || (this.toBoolean(options.detached, false) ? "detached" : "inline");
        const targetKey = String(options.target || positional[0] || "uncommitted").toLowerCase();
        let target = { type: "uncommittedChanges" };
        if (["base", "basebranch"].includes(targetKey)) {
          const branch = options.branch || positional[1];
          if (!branch) {
            await this.sendMessage(adapter, context, "Usage: /turn review base <branch> [--delivery inline|detached]");
            return;
          }
          target = { type: "baseBranch", branch };
        } else if (targetKey === "commit") {
          const sha = options.sha || positional[1];
          if (!sha) {
            await this.sendMessage(adapter, context, "Usage: /turn review commit <sha> [title words]");
            return;
          }
          const title = options.title || positional.slice(2).join(" ").trim() || null;
          target = { type: "commit", sha, title };
        } else if (targetKey === "custom") {
          const instructions = (options.instructions || positional.slice(1).join(" ")).trim();
          if (!instructions) {
            await this.sendMessage(adapter, context, "Usage: /turn review custom <instructions...>");
            return;
          }
          target = { type: "custom", instructions };
        }

        const review = await runtime.startReview({
          threadId: binding.threadId,
          delivery,
          target,
        });
        const reviewTurnId = this.turnIdFromResponse(review);
        const reviewThreadId = review?.reviewThreadId || binding.threadId;
        this.threadToBinding.set(reviewThreadId, bKey);
        if (delivery === "detached" && reviewThreadId && reviewThreadId !== binding.threadId) {
          const updated = store.upsertBinding({
            ...binding,
            threadId: reviewThreadId,
          });
          Object.assign(binding, updated);
        }
        if (reviewTurnId) {
          this.turnToBinding.set(reviewTurnId, bKey);
          this.activeTurnByBinding.set(bKey, reviewTurnId);
        }
        await this.sendMessage(
          adapter,
          context,
          `Review started (${delivery}) on thread ${reviewThreadId}${reviewTurnId ? `, turn ${reviewTurnId}` : ""}.`
        );
        return;
      }
      await this.sendMessage(adapter, context, "Usage: /turn <ask|steer|interrupt|review>");
      return;
    }

    if (command.type === "thread") {
      const action = command.action || "";
      const { positional, options } = this.parseArgsAndOptions(command.args);

      if (action === "start") {
        const cwdResolved = options.cwd ? this.resolveWorkspacePath(options.cwd, binding.workingDir) : { value: binding.workingDir };
        if (cwdResolved.error) {
          await this.sendMessage(adapter, context, cwdResolved.error);
          return;
        }
        const response = await runtime.startThread({
          cwd: cwdResolved.value,
          approvalPolicy: binding.policyProfile.approvalMode,
          model: options.model || binding.policyProfile.model || null,
        });
        const threadId = this.threadIdFromResponse(response);
        if (threadId) {
          this.threadToBinding.set(threadId, bKey);
          const updated = store.upsertBinding({
            ...binding,
            threadId,
            workingDir: cwdResolved.value,
          });
          Object.assign(binding, updated);
        }
        await this.sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
        return;
      }

      if (action === "resume") {
        await runResume(positional[0]);
        return;
      }

      if (action === "list" || action === "more") {
        const requestedLimitRaw = positional.find((item) => /^\d+$/.test(item));
        let requestedLimit = this.toInt(requestedLimitRaw, 10, 1, 100);
        const useAll = action === "list" && (positional.some((item) => item.toLowerCase() === "all") || this.toBoolean(options.all, false));
        let archived = this.toBoolean(options.archived, false);

        let cursor = null;
        let cwdFilter = null;
        if (action === "more") {
          const state = this.getThreadListState(bKey);
          if (!state?.nextCursor) {
            await this.sendMessage(adapter, context, "No next page available. Run /thread list first.");
            return;
          }
          cursor = state.nextCursor;
          cwdFilter = state.cwdFilter;
          archived = Boolean(state.archived);
          if (!requestedLimitRaw && Number.isFinite(Number(state.limit))) {
            requestedLimit = this.toInt(state.limit, 10, 1, 100);
          }
        } else {
          cwdFilter = useAll ? null : (options.cwd || binding.workingDir);
          cursor = options.cursor || null;
        }

        const response = await runtime.listThreads({
          cursor,
          limit: requestedLimit,
          archived,
          cwd: cwdFilter,
        });
        const threads = this.threadListFromResponse(response);
        const nextCursor = this.nextCursorFromResponse(response);
        this.setThreadListState(bKey, {
          nextCursor,
          cwdFilter,
          archived,
          limit: requestedLimit,
        });

        if (!threads.length) {
          const suffix = cwdFilter ? ` for workspace: ${cwdFilter}` : "";
          await this.sendMessage(adapter, context, `No threads found${suffix}.`);
          return;
        }

        const entries = threads.map((thread, index) => {
          const id = this.extractThreadId(thread) || "unknown";
          const marker = binding.threadId && id === binding.threadId ? " (current)" : "";
          const title = this.threadDisplayTitle(thread);
          const cwd = this.extractThreadCwd(thread) || "unknown";
          return `${index + 1}. ${title}\t\t${cwd}\t\t${id}${marker}`;
        });
        await this.sendMessage(
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
          await this.sendMessage(adapter, context, "Usage: /thread read <threadId> [--turns true]");
          return;
        }
        const includeTurns = this.toBoolean(options.turns, false);
        const read = await runtime.readThread({ threadId, includeTurns });
        const thread = read?.thread || {};
        await this.sendMessage(
          adapter,
          context,
          [
            `Thread: ${thread.id || threadId}`,
            `Title: ${thread.name || this.threadDisplayTitle(thread)}`,
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
          await this.sendMessage(adapter, context, "Usage: /thread fork <threadId> [--ephemeral true]");
          return;
        }
        const forked = await runtime.forkThread({
          threadId: sourceThreadId,
          ephemeral: this.toBoolean(options.ephemeral, false),
        });
        const newThreadId = this.threadIdFromResponse(forked);
        if (newThreadId) {
          this.threadToBinding.set(newThreadId, bKey);
        }
        await this.sendMessage(adapter, context, `Forked thread: ${newThreadId || "unknown"}`);
        return;
      }

      if (action === "loaded") {
        const loaded = await runtime.listLoadedThreads();
        const ids = Array.isArray(loaded?.data)
          ? loaded.data
          : (Array.isArray(loaded?.threadIds) ? loaded.threadIds : []);
        await this.sendMessage(
          adapter,
          context,
          ids.length ? `Loaded threads:\n${ids.join("\n")}` : "No loaded threads."
        );
        return;
      }

      if (action === "unsubscribe") {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.sendMessage(adapter, context, "Usage: /thread unsubscribe <threadId>");
          return;
        }
        const result = await runtime.unsubscribeThread(threadId);
        await this.sendMessage(adapter, context, `Unsubscribe status: ${result?.status || "ok"} (${threadId})`);
        return;
      }

      if (["archive", "unarchive", "compact", "rollback"].includes(action)) {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.sendMessage(adapter, context, `Usage: /thread ${action} <threadId> --confirm`);
          return;
        }
        if (this.riskyThreadActionRequiresConfirm(binding.policyProfile.approvalMode) && !this.toBoolean(options.confirm, false)) {
          await this.sendMessage(
            adapter,
            context,
            `Confirmation required by approval mode. Re-run with --confirm.\nExample: /thread ${action} ${threadId} --confirm`
          );
          return;
        }

        if (action === "archive") {
          await runtime.archiveThread(threadId);
          if (binding.threadId === threadId) {
            const updated = store.upsertBinding({ ...binding, threadId: null });
            Object.assign(binding, updated);
          }
          this.threadToBinding.delete(threadId);
          await this.sendMessage(adapter, context, `Archived thread: ${threadId}`);
          return;
        }
        if (action === "unarchive") {
          await runtime.unarchiveThread(threadId);
          await this.sendMessage(adapter, context, `Unarchived thread: ${threadId}`);
          return;
        }
        if (action === "compact") {
          await runtime.compactThread(threadId);
          await this.sendMessage(adapter, context, `Compaction started for thread: ${threadId}`);
          return;
        }
        if (action === "rollback") {
          const numTurns = this.toInt(options.turns || positional[1], 1, 1, 100);
          await runtime.rollbackThread({ threadId, numTurns });
          await this.sendMessage(adapter, context, `Rolled back ${numTurns} turn(s) on thread: ${threadId}`);
          return;
        }
      }

      await this.sendMessage(
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
      await this.handle({
        ...context,
        text: `/thread list ${listCmd.args.join(" ")}`,
      });
      return;
    }

    if (command.type === "archive") {
      const threadId = String(command.threadId || binding.threadId || "").trim();
      if (!threadId) {
        await this.sendMessage(adapter, context, "No thread selected. Use /archive <threadId> or /resume <threadId> first.");
        return;
      }
      await this.handle({
        ...context,
        text: `/thread archive ${threadId}`,
      });
      return;
    }

    const modelOrSkillsHandled = await this.handleModelAndSkillsCommand({
      command,
      adapter,
      context,
      binding,
      runtime,
      store,
      sendMessage: (targetAdapter, targetContext, message) => this.sendMessage(targetAdapter, targetContext, message),
      parseArgsAndOptions: this.parseArgsAndOptions,
      resolveWorkspacePath: this.resolveWorkspacePath,
      toBoolean: this.toBoolean,
      toInt: this.toInt,
      modelListFromResponse: this.modelListFromResponse,
      collaborationModesFromResponse: this.collaborationModesFromResponse,
      loadSkillsForCwd: (cwd, options) => this.loadSkillsForCwd(cwd, options),
      touchSkillsContext: (targetBinding, cwd, skills) => this.touchSkillsContext(targetBinding, cwd, skills),
      resolveSkillByName: (targetBinding, cwd, name, options) => this.resolveSkillByName(targetBinding, cwd, name, options),
      runAsk,
      clearSkillCache: (cwd) => this.clearSkillCache(cwd),
    });
    if (modelOrSkillsHandled) {
      return;
    }

    if (command.type === "approve") {
      if (!command.requestId || !["allow", "deny"].includes(command.decision)) {
        await this.sendMessage(adapter, context, "Usage: /approve <requestId> <allow|deny> [payload]");
        return;
      }

      const resolution = approvalBroker.resolve(command.requestId, {
        decision: command.decision,
        payload: command.payload,
        actor: context.userId,
      });

      if (!resolution) {
        await this.sendMessage(adapter, context, `Unknown or expired approval request: ${command.requestId}`);
      }
      return;
    }

    if (command.type === "cwd") {
      const resolved = this.resolveWorkspacePath(command.path, binding.workingDir);
      if (resolved.error) {
        await this.sendMessage(adapter, context, resolved.error);
        return;
      }

      const updated = store.upsertBinding({
        ...binding,
        workingDir: resolved.value,
      });
      await this.sendMessage(
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

    await this.sendMessage(
      adapter,
      context,
      "Unknown command. Use /help to see all commands and examples."
    );
  }
}
