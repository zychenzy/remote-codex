import { spawn } from "node:child_process";
import { EventBus } from "./events.js";
import { JsonRpcClient } from "./json-rpc-client.js";

function defaultLaunchSpec() {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "codex app-server"],
      description: "cmd.exe /d /c codex app-server",
      options: { windowsHide: true },
    };
  }
  return {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    description: "codex app-server --listen stdio://",
    options: {},
  };
}

function toTextInput(input) {
  return [{ type: "text", text: input }];
}

function pickDefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null)
  );
}

function normalizeCollaborationMode(collaborationMode, { model = null, effort = null } = {}) {
  if (!collaborationMode) {
    return null;
  }
  if (typeof collaborationMode === "object") {
    return {
      ...collaborationMode,
      settings: { model, reasoning_effort: effort, developer_instructions: null, ...collaborationMode.settings },
    };
  }
  const mode = String(collaborationMode || "").trim();
  if (!mode) {
    return null;
  }
  const settings = {
    developer_instructions: null,
  };
  const normalizedModel = String(model || "").trim();
  const normalizedEffort = String(effort || "").trim();
  if (normalizedModel) {
    settings.model = normalizedModel;
  }
  if (normalizedEffort) {
    settings.reasoning_effort = normalizedEffort;
  }
  return {
    mode,
    settings,
  };
}

export class AppServerRuntime {
  constructor({
    launchSpec,
    env = process.env,
    reconnect = true,
    reconnectDelayMs = 1500,
    reconnectMaxDelayMs = 30_000,
    reconnectMaxAttempts = Infinity,
    requestTimeoutMs = 60_000,
    stopTimeoutMs = 10_000,
    logger = console,
  } = {}) {
    this.launchSpec = launchSpec || defaultLaunchSpec();
    this.env = env;
    this.reconnect = reconnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectMaxAttempts = reconnectMaxAttempts;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.logger = logger;

    this.child = null;
    this.buffer = "";
    this.rpc = null;
    this.events = new EventBus({ logger });
    this.initialized = false;
    this.manualStop = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.threadModels = new Map();
    this.initializePromise = null;
  }

  on(event, handler) {
    return this.events.on(event, handler);
  }

  async initialize() {
    await this.#ensureStarted();

    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }
    const rpc = this.rpc;
    this.initializePromise = this.#initializeRpc(rpc);
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async #initializeRpc(rpc) {
    await rpc.request("initialize", {
      clientInfo: {
        name: "im-codex-tool",
        title: "IM Codex Tool",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    rpc.notify("initialized");
    this.initialized = true;
    this.events.emit("ready", { initialized: true });
  }

  async startThread({
    cwd,
    approvalPolicy = "on-request",
    sandbox = "workspace-write",
    model = null,
    personality = null,
    serviceName = null,
    persistExtendedHistory = null,
    dynamicTools = null,
    ephemeral = null,
    serviceTier = undefined,
  } = {}) {
    await this.initialize();
    const response = await this.rpc.request("thread/start", {
      ...pickDefined({
        cwd,
        approvalPolicy,
        sandbox,
        model,
        personality,
        serviceName,
        dynamicTools,
        ephemeral,
        // persistExtendedHistory is retained as a public argument for older
        // callers, but the current wire protocol no longer accepts the field.
      }),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    });
    if (response.model) this.threadModels.set(response.thread.id, response.model);
    return response;
  }

  async resumeThread(threadId, overrides = {}) {
    await this.initialize();
    const response = await this.rpc.request("thread/resume", pickDefined({ threadId, ...overrides }));
    if (response.model) this.threadModels.set(threadId, response.model);
    return response;
  }

  async startTurn({
    threadId,
    input,
    approvalPolicy = null,
    cwd = null,
    model = null,
    effort = null,
    collaborationMode = null,
    personality = null,
    sandboxPolicy = null,
    outputSchema = null,
    summary = null,
    serviceTier = undefined,
  } = {}) {
    await this.initialize();
    let modeModel = collaborationMode?.settings?.model || model || this.threadModels.get(threadId);
    if (collaborationMode && !modeModel) {
      const models = await this.listModels();
      modeModel = models.data?.find((entry) => entry.isDefault)?.model;
      if (!modeModel) throw new Error("Collaboration mode requires a model; select one with /model set.");
    }
    const normalizedCollaborationMode = normalizeCollaborationMode(collaborationMode, { model: modeModel, effort });
    const response = await this.rpc.request("turn/start", {
      ...pickDefined({
        threadId,
        input: Array.isArray(input) ? input : toTextInput(String(input || "")),
        approvalPolicy,
        cwd,
        model,
        effort,
        collaborationMode: normalizedCollaborationMode,
        personality,
        sandboxPolicy,
        outputSchema,
        summary,
      }),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    });
    if (modeModel) this.threadModels.set(threadId, modeModel);
    return response;
  }

  async steerTurn({ threadId, expectedTurnId, input } = {}) {
    await this.initialize();
    return this.rpc.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: Array.isArray(input) ? input : toTextInput(String(input || "")),
    });
  }

  async interruptTurn({ threadId, turnId } = {}) {
    await this.initialize();
    return this.rpc.request("turn/interrupt", {
      threadId,
      turnId,
    });
  }

  async listThreads({
    cursor = null,
    limit = 50,
    archived = false,
    sortKey = null,
    modelProviders = null,
    sourceKinds = null,
    cwd = null,
    searchTerm = null,
  } = {}) {
    await this.initialize();
    return this.rpc.request("thread/list", pickDefined({
      cursor,
      limit,
      archived,
      sortKey,
      modelProviders,
      sourceKinds,
      cwd,
      searchTerm,
    }));
  }

  async archiveThread(threadId) {
    await this.initialize();
    return this.rpc.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId) {
    await this.initialize();
    return this.rpc.request("thread/unarchive", { threadId });
  }

  async readThread({ threadId, includeTurns = false } = {}) {
    await this.initialize();
    return this.rpc.request("thread/read", { threadId, includeTurns });
  }

  async forkThread({ threadId, ephemeral = false } = {}) {
    await this.initialize();
    return this.rpc.request("thread/fork", { threadId, ephemeral });
  }

  async listLoadedThreads({ cursor = null, limit = null } = {}) {
    await this.initialize();
    return this.rpc.request("thread/loaded/list", pickDefined({ cursor, limit }));
  }

  async unsubscribeThread(threadId) {
    await this.initialize();
    return this.rpc.request("thread/unsubscribe", { threadId });
  }

  async compactThread(threadId) {
    await this.initialize();
    return this.rpc.request("thread/compact/start", { threadId });
  }

  async rollbackThread({ threadId, numTurns = 1 } = {}) {
    await this.initialize();
    return this.rpc.request("thread/rollback", { threadId, numTurns });
  }

  async setThreadName({ threadId, name } = {}) {
    await this.initialize();
    return this.rpc.request("thread/name/set", { threadId, name });
  }

  async getThreadGoal(threadId) {
    await this.initialize();
    return this.rpc.request("thread/goal/get", { threadId });
  }

  async setThreadGoal({ threadId, goal, objective = goal, status, tokenBudget } = {}) {
    await this.initialize();
    return this.rpc.request("thread/goal/set", {
      ...pickDefined({ threadId, objective, status }),
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
  }

  async clearThreadGoal(threadId) {
    await this.initialize();
    return this.rpc.request("thread/goal/clear", { threadId });
  }

  async readAccountRateLimits() {
    await this.initialize();
    return this.rpc.request("account/rateLimits/read", {});
  }

  async readConfigRequirements() {
    await this.initialize();
    return this.rpc.request("configRequirements/read", {});
  }

  async startReview({
    threadId,
    delivery = "inline",
    target = { type: "uncommittedChanges" },
  } = {}) {
    await this.initialize();
    return this.rpc.request("review/start", { threadId, delivery, target });
  }

  async listModels({ cursor = null, limit = 20, includeHidden = false } = {}) {
    await this.initialize();
    return this.rpc.request("model/list", pickDefined({ cursor, limit, includeHidden }));
  }

  async listCollaborationModes() {
    await this.initialize();
    return this.rpc.request("collaborationMode/list", {});
  }

  async listSkills({
    cwds = null,
    forceReload = false,
    perCwdExtraUserRoots = null,
  } = {}) {
    await this.initialize();
    return this.rpc.request("skills/list", pickDefined({
      cwds,
      forceReload,
      perCwdExtraUserRoots,
    }));
  }

  async writeSkillConfig({ path, enabled } = {}) {
    await this.initialize();
    return this.rpc.request("skills/config/write", { path, enabled });
  }

  async commandExec({ command, cwd = null } = {}) {
    await this.initialize();
    return this.rpc.request("command/exec", { command, cwd });
  }

  async respondServerRequest(requestId, result) {
    this.#sendLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result,
      })
    );
  }

  async respondServerError(requestId, { code = -32601, message = "Unsupported server request" } = {}) {
    this.#sendLine(JSON.stringify({ id: requestId, error: { code, message } }));
  }

  // H4-core: graceful stop. Sends SIGTERM, awaits the child's "close" with a
  // timeout, then escalates to SIGKILL so a hung child can never orphan. The
  // returned promise resolves only once the child has actually exited. Mirrors
  // the SIGTERM-then-verify-then-escalate idiom in ops-cli/daemon-instance.js.
  async stop() {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.rpc) {
      this.rpc.close("runtime stopped");
    }

    const child = this.child;
    this.child = null;

    if (!child) {
      return;
    }

    if (child.exitCode != null || child.signalCode != null) {
      return;
    }

    await new Promise((resolve) => {
      let killTimer = null;
      const onClose = () => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve();
      };
      child.once("close", onClose);

      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        // Escalate: SIGTERM did not land within stopTimeoutMs. "close" still
        // fires after SIGKILL and resolves the promise via onClose.
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }, this.stopTimeoutMs);
      killTimer.unref?.();
    });
  }

  async #ensureStarted() {
    if (this.child && this.rpc) {
      return;
    }

    this.manualStop = false;
    // C5a: reset the stdout line buffer on every (re)start. Otherwise a partial
    // line left by an unclean child death is concatenated onto the new child's
    // first chunk, corrupting one message (and stalling reconnect if it was the
    // initialize response).
    this.buffer = "";
    this.initialized = false;
    this.threadModels.clear();

    if (this.launchSpec.description) {
      this.logger?.log?.(`spawning app-server: ${this.launchSpec.description}`);
    }

    const child = spawn(this.launchSpec.command, this.launchSpec.args, {
      env: { ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...this.launchSpec.options,
    });

    this.child = child;

    const rpc = new JsonRpcClient({
      send: (line) => this.#sendLine(line),
      timeoutMs: this.requestTimeoutMs,
    });
    this.rpc = rpc;

    rpc.on("notification", (msg) => this.events.emit("notification", msg));
    rpc.on("serverRequest", (msg) => this.events.emit("serverRequest", msg));
    rpc.on("malformed", (msg) => this.events.emit("malformed", msg));
    rpc.on("orphanResponse", (msg) => this.events.emit("orphanResponse", msg));

    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          rpc.handleMessage(trimmed);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      this.events.emit("stderr", chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      this.events.emit("error", error);
      // M-spawnerror: on a spawn failure (e.g. ENOENT) "close" may never fire,
      // so without teardown this.child/this.rpc stay set and the in-flight
      // initialize() hangs for requestTimeoutMs. Tear down the same way "close"
      // does so initialize() (and any reconnect attempt) fails fast. If close
      // does also fire, the teardown is idempotent.
      this.#teardown(child, rpc, `app-server spawn error: ${error.message}`);
      this.#maybeReconnect();
    });

    child.on("close", (code, signal) => {
      this.events.emit("close", { code, signal });
      this.#teardown(child, rpc, `app-server closed (${code ?? "n/a"})`);
      this.#maybeReconnect();
    });
  }

  // Idempotent teardown shared by the "error" and "close" handlers. Only clears
  // the current child/rpc if they still point at the instance being torn down,
  // so a stale handler from a previous child cannot wipe a freshly started one.
  #teardown(child, rpc, reason) {
    if (this.child === child) {
      this.child = null;
    }
    this.initialized = false;
    if (this.rpc === rpc) {
      this.rpc = null;
    }
    rpc.close(reason);
  }

  // C5b: reconnect loops with capped exponential backoff, re-arming on each
  // failed attempt, until it succeeds, manualStop is set, or reconnectMaxAttempts
  // is exhausted (after which a terminal "down" event is emitted). A single
  // pending timer guards against concurrent loops (e.g. error + close both fire).
  #maybeReconnect() {
    if (this.manualStop || !this.reconnect || this.reconnectTimer) {
      return;
    }

    if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
      this.events.emit("down", { attempts: this.reconnectAttempts });
      return;
    }

    const delay = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxDelayMs
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // ponytail: manualStop is re-checked here and inside #maybeReconnect, but
      // a stop() that lands during the await below can still race a mid-spawn
      // reconnect. Closing that window fully needs an abort token; out of scope.
      if (this.manualStop) {
        return;
      }
      try {
        await this.initialize();
        this.reconnectAttempts = 0;
        this.events.emit("reconnected", { ok: true });
      } catch (err) {
        this.events.emit("error", err);
        // Re-arm: the next attempt backs off further or emits "down".
        this.#maybeReconnect();
      }
    }, delay);
  }

  #sendLine(line) {
    if (!this.child?.stdin?.writable) {
      throw new Error("app-server stdin is not writable");
    }
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }
}
