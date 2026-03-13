import { EventBus } from "./events.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class JsonRpcClient {
  constructor({ send, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    if (typeof send !== "function") {
      throw new Error("JsonRpcClient requires a send function");
    }
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new EventBus();
  }

  on(event, handler) {
    return this.events.on(event, handler);
  }

  request(method, params) {
    const id = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method, startedAt: this.now() });
      this.send(JSON.stringify(request));
    });
  }

  notify(method, params) {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.send(JSON.stringify(notification));
  }

  handleMessage(rawLine) {
    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      this.events.emit("malformed", { rawLine });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      this.#handleResponse(message);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      this.events.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.events.emit("notification", message);
      return;
    }

    this.events.emit("unknown", message);
  }

  #handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.events.emit("orphanResponse", message);
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      const errMessage = message.error.message || `JSON-RPC error for ${pending.method}`;
      const err = new Error(errMessage);
      err.code = message.error.code;
      err.data = message.error.data;
      pending.reject(err);
      return;
    }

    pending.resolve(message.result);
  }

  close(reason = "client closed") {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`JSON-RPC request ${id} canceled: ${reason}`));
    }
    this.pending.clear();
  }
}
