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

function normalizeDecision(decision) {
  return decision === "allow" ? "allow" : "deny";
}

function decisionForMethod(method, decision, payload) {
  const normalized = normalizeDecision(decision);

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

  create({ serverRequest, binding, autoApprove = false, initiatorUserId = null }) {
    const localRequestId = crypto.randomUUID();

    const record = {
      localRequestId,
      serverRequestId: serverRequest.id,
      method: serverRequest.method,
      params: serverRequest.params,
      binding,
      initiatorUserId: initiatorUserId ?? null,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    const timer = setTimeout(() => {
      const entry = this.pending.get(localRequestId);
      if (!entry || entry.resolved) {
        return;
      }
      this.#finalize(entry, { decision: "deny", payload: "", actor: "system", timeout: true });
    }, this.timeoutMs);

    const entry = {
      record,
      timer,
      resolved: false,
    };
    this.pending.set(localRequestId, entry);

    if (autoApprove) {
      // Route auto-approve through the same pending + resolve path so a single
      // code path enforces single-resolution. overrideOwnership: system actor.
      this.resolve(localRequestId, { decision: "allow", actor: "system", overrideOwnership: true });
      return { record, autoResolved: true };
    }

    return { record, autoResolved: false };
  }

  resolve(localRequestId, { decision, payload = "", actor = "user", overrideOwnership = false } = {}) {
    const entry = this.pending.get(localRequestId);
    if (!entry || entry.resolved) {
      return null;
    }

    const initiatorUserId = entry.record.initiatorUserId ?? null;
    if (
      initiatorUserId != null
      && actor != null
      && actor !== initiatorUserId
      && overrideOwnership !== true
    ) {
      return { notOwner: true };
    }

    return this.#finalize(entry, { decision, payload, actor });
  }

  #finalize(entry, { decision, payload = "", actor = "user", timeout = false }) {
    entry.resolved = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.record.localRequestId);

    const normalized = normalizeDecision(decision);
    const response = decisionForMethod(entry.record.method, normalized, payload);
    const resolution = {
      localRequestId: entry.record.localRequestId,
      decision: normalized,
      actor,
      payload,
      response,
      record: entry.record,
      initiatorUserId: entry.record.initiatorUserId ?? null,
    };
    if (timeout) {
      resolution.timeout = true;
    }

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
