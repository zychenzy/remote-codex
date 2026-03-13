import { EventEmitter } from "node:events";
import crypto from "node:crypto";

function parseToolInputPayload(payloadText) {
  if (!payloadText) {
    return { answers: {} };
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object") {
      return parsed;
    }
  } catch {
    // ignore json parse failure
  }

  const answers = {};
  for (const chunk of String(payloadText).split(";")) {
    const [rawKey, rawValue] = chunk.split("=");
    const key = (rawKey || "").trim();
    const value = (rawValue || "").trim();
    if (!key) {
      continue;
    }
    answers[key] = { answers: value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [] };
  }

  return { answers };
}

function decisionForMethod(method, decision, payload) {
  const normalized = decision === "allow" ? "allow" : "deny";

  if (method === "item/commandExecution/requestApproval") {
    return {
      decision: normalized === "allow" ? "accept" : "decline",
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      decision: normalized === "allow" ? "accept" : "decline",
    };
  }

  if (method === "item/tool/requestUserInput") {
    return normalized === "allow" ? parseToolInputPayload(payload) : { answers: {} };
  }

  return {
    decision: normalized === "allow" ? "accept" : "decline",
  };
}

export class ApprovalBroker extends EventEmitter {
  constructor({ timeoutMs = 5 * 60 * 1000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  create({ serverRequest, binding, autoApprove = false }) {
    const localRequestId = crypto.randomUUID();

    const record = {
      localRequestId,
      serverRequestId: serverRequest.id,
      method: serverRequest.method,
      params: serverRequest.params,
      binding,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    if (autoApprove) {
      const resolution = {
        localRequestId,
        decision: "allow",
        response: decisionForMethod(serverRequest.method, "allow", ""),
        record,
      };
      this.emit("resolved", resolution);
      return { record, autoResolved: true };
    }

    const timer = setTimeout(() => {
      this.pending.delete(localRequestId);
      const resolution = {
        localRequestId,
        decision: "deny",
        response: decisionForMethod(serverRequest.method, "deny", ""),
        record,
        timeout: true,
      };
      this.emit("resolved", resolution);
    }, this.timeoutMs);

    this.pending.set(localRequestId, {
      record,
      timer,
      resolved: false,
    });

    return { record, autoResolved: false };
  }

  resolve(localRequestId, { decision, payload = "", actor = "user" } = {}) {
    const entry = this.pending.get(localRequestId);
    if (!entry || entry.resolved) {
      return null;
    }

    entry.resolved = true;
    clearTimeout(entry.timer);
    this.pending.delete(localRequestId);

    const response = decisionForMethod(entry.record.method, decision, payload);
    const resolution = {
      localRequestId,
      decision,
      actor,
      payload,
      response,
      record: entry.record,
    };

    this.emit("resolved", resolution);
    return resolution;
  }

  getPending(localRequestId) {
    return this.pending.get(localRequestId)?.record || null;
  }

  listPending() {
    return [...this.pending.values()].map((entry) => entry.record);
  }

  clearAll() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
  }
}
