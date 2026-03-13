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

export class AppServerRuntime {
  constructor({
    launchSpec,
    env = process.env,
    reconnect = true,
    reconnectDelayMs = 1500,
    requestTimeoutMs = 60_000,
    logger = console,
  } = {}) {
    this.launchSpec = launchSpec || defaultLaunchSpec();
    this.env = env;
    this.reconnect = reconnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;

    this.child = null;
    this.buffer = "";
    this.rpc = null;
    this.events = new EventBus();
    this.initialized = false;
    this.manualStop = false;
    this.reconnectTimer = null;
  }

  on(event, handler) {
    return this.events.on(event, handler);
  }

  async initialize() {
    await this.#ensureStarted();

    if (this.initialized) {
      return;
    }

    await this.rpc.request("initialize", {
      clientInfo: {
        name: "im-codex-tool",
        title: "IM Codex Tool",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.rpc.notify("initialized");
    this.initialized = true;
    this.events.emit("ready", { initialized: true });
  }

  async startThread({ cwd, approvalPolicy = "on-request", sandbox = "workspace-write", model = null } = {}) {
    await this.initialize();
    return this.rpc.request("thread/start", {
      cwd,
      approvalPolicy,
      sandbox,
      model,
    });
  }

  async resumeThread(threadId) {
    await this.initialize();
    return this.rpc.request("thread/resume", { threadId });
  }

  async startTurn({ threadId, input, approvalPolicy = null, cwd = null, model = null } = {}) {
    await this.initialize();
    return this.rpc.request("turn/start", {
      threadId,
      input: Array.isArray(input) ? input : toTextInput(String(input || "")),
      approvalPolicy,
      cwd,
      model,
    });
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

  async listThreads({ limit = 50, archived = false } = {}) {
    await this.initialize();
    return this.rpc.request("thread/list", { limit, archived });
  }

  async commandExec({ command, cwd = null } = {}) {
    await this.initialize();
    return this.rpc.request("command/exec", { command, cwd });
  }

  async respondServerRequest(requestId, result) {
    await this.initialize();
    this.#sendLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result,
      })
    );
  }

  async stop() {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.rpc) {
      this.rpc.close("runtime stopped");
    }

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    if (child.exitCode == null) {
      child.kill("SIGTERM");
    }
  }

  async #ensureStarted() {
    if (this.child && this.rpc) {
      return;
    }

    this.manualStop = false;

    const child = spawn(this.launchSpec.command, this.launchSpec.args, {
      env: { ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...this.launchSpec.options,
    });

    this.child = child;
    this.initialized = false;

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
    });

    child.on("close", (code, signal) => {
      this.events.emit("close", { code, signal });
      this.child = null;
      this.initialized = false;
      rpc.close(`app-server closed (${code ?? "n/a"})`);

      if (!this.manualStop && this.reconnect) {
        this.reconnectTimer = setTimeout(async () => {
          try {
            await this.initialize();
            this.events.emit("reconnected", { ok: true });
          } catch (err) {
            this.events.emit("error", err);
          }
        }, this.reconnectDelayMs);
      }
    });
  }

  #sendLine(line) {
    if (!this.child?.stdin?.writable) {
      throw new Error("app-server stdin is not writable");
    }
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }
}
