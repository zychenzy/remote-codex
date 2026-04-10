import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const AUDIT_FLUSH_INTERVAL_MS = 250;
const DELIVERY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_DEDUPE_MAX_ENTRIES = 5_000;
const CHANNEL_CURSOR_MAX_ENTRIES = 5_000;
const AUTOPILOT_DEFAULT_COMMAND_ALLOW_PREFIXES = [
  "pwd",
  "ls",
  "rg ",
  "git status",
  "npm test",
  "pnpm test",
];

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isWritableDir(dir) {
  try {
    ensureDir(dir);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value, mode) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(temp, filePath);
}

function keyOf(channel, chatId) {
  return `${channel}:${chatId}`;
}

function normalizeInt(value, fallback, min = 1, max = 10_000) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function parseAuditLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeDeliveryMap(raw = {}, { nowMs, ttlMs, maxEntries } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttl = normalizeInt(ttlMs, DELIVERY_DEDUPE_TTL_MS, 1_000, 30 * 24 * 60 * 60 * 1000);
  const max = normalizeInt(maxEntries, DELIVERY_DEDUPE_MAX_ENTRIES, 100, 100_000);
  const minTs = now - ttl;

  const entries = Object.entries(raw || {})
    .map(([key, value]) => [String(key), Number(value)])
    .filter(([key, value]) => key && Number.isFinite(value) && value >= minTs)
    .sort((a, b) => a[1] - b[1]);

  const trimmed = entries.slice(-max);
  return Object.fromEntries(trimmed);
}

function normalizeCursorMap(raw = {}, { maxEntries = CHANNEL_CURSOR_MAX_ENTRIES } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const entries = Object.entries(source)
    .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
    .filter(([key, value]) => key && value)
    .slice(-maxEntries);
  return Object.fromEntries(entries);
}

function normalizeThreadAutoApproveByThreadId(raw = {}, { maxEntries = 500 } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const entries = Object.entries(source)
    .map(([threadId, enabled]) => [String(threadId || "").trim(), Boolean(enabled)])
    .filter(([threadId, enabled]) => threadId && enabled)
    .slice(-maxEntries);
  return Object.fromEntries(entries);
}

function normalizeStringList(raw = [], { maxEntries = 200 } = {}) {
  const values = Array.isArray(raw) ? raw : [];
  return [...new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, maxEntries)
  )];
}

function normalizeAutopilotMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "rules") {
    return "conservative";
  }
  return ["conservative", "aggressive"].includes(normalized) ? normalized : "conservative";
}

function normalizeAutopilotToolInputStrategy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["recommended_only"].includes(normalized) ? normalized : "recommended_only";
}

function normalizeAutopilotPolicy(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Boolean(source.enabled),
    mode: normalizeAutopilotMode(source.mode),
    continueOnTurnComplete: Boolean(source.continueOnTurnComplete),
    maxAutomaticTurns: normalizeInt(source.maxAutomaticTurns, 5, 1, 100),
    maxConsecutivePauses: normalizeInt(source.maxConsecutivePauses, 2, 1, 100),
    commandAllowPrefixes: normalizeStringList(
      Array.isArray(source.commandAllowPrefixes) && source.commandAllowPrefixes.length
        ? source.commandAllowPrefixes
        : AUTOPILOT_DEFAULT_COMMAND_ALLOW_PREFIXES
    ),
    allowedWriteRoots: normalizeStringList(source.allowedWriteRoots || []),
    toolInputStrategy: normalizeAutopilotToolInputStrategy(source.toolInputStrategy),
  };
}

function normalizeAutopilotSessions(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const normalized = {};
  for (const [bindingKey, session] of Object.entries(source)) {
    const key = String(bindingKey || "").trim();
    if (!key || !session || typeof session !== "object") {
      continue;
    }
    normalized[key] = {
      bindingKey: key,
      threadId: session.threadId ? String(session.threadId) : null,
      activeTurnId: session.activeTurnId ? String(session.activeTurnId) : null,
      status: String(session.status || "idle").trim() || "idle",
      automaticTurns: normalizeInt(session.automaticTurns, 0, 0, 10_000),
      consecutivePauses: normalizeInt(session.consecutivePauses, 0, 0, 10_000),
      lastCompletionFingerprint: session.lastCompletionFingerprint
        ? String(session.lastCompletionFingerprint)
        : null,
      repeatedCompletionCount: normalizeInt(session.repeatedCompletionCount, 0, 0, 10_000),
      lastAction: session.lastAction && typeof session.lastAction === "object"
        ? { ...session.lastAction }
        : null,
      updatedAt: String(session.updatedAt || nowIso()),
    };
  }
  return normalized;
}

export class StateStore {
  constructor({ baseDir } = {}) {
    const preferred = baseDir || path.join(os.homedir(), ".im-codex-tool");
    const fallback = path.join(process.cwd(), ".im-codex-tool");
    this.baseDir = isWritableDir(preferred) ? preferred : fallback;
    this.dataDir = path.join(this.baseDir, "data");
    this.runtimeDir = path.join(this.baseDir, "runtime");
    this.logsDir = path.join(this.baseDir, "logs");
    this.configPath = path.join(this.baseDir, "config.json");

    this.bindingsPath = path.join(this.dataDir, "bindings.json");
    this.pendingApprovalsPath = path.join(this.dataDir, "pending-approvals.json");
    this.sessionsPath = path.join(this.dataDir, "sessions.json");
    this.autopilotSessionsPath = path.join(this.dataDir, "autopilot-sessions.json");
    this.auditPath = path.join(this.dataDir, "audit.jsonl");
    this.deliveryDedupePath = path.join(this.dataDir, "delivery-dedupe.json");
    this.channelCursorPath = path.join(this.dataDir, "channel-cursors.json");
    this.auditBuffer = [];
    this.auditInFlight = [];
    this.auditFlushTimer = null;
    this.auditFlushChain = Promise.resolve();
    this.deliveryDedupeCache = null;
    this.channelCursorCache = null;

    ensureDir(this.baseDir);
    ensureDir(this.dataDir);
    ensureDir(this.runtimeDir);
    ensureDir(this.logsDir);
  }

  readConfig() {
    const raw = readJson(this.configPath, {});
    const normalized = {
      runtime: {
        appServer: {
          command: raw?.runtime?.appServer?.command || "codex",
          args: raw?.runtime?.appServer?.args || ["app-server", "--listen", "stdio://"],
        },
      },
      defaults: {
        workingDir: raw?.defaults?.workingDir || os.homedir(),
        approvalMode: raw?.defaults?.approvalMode || "on-request",
        output: {
          resumeHistoryTurns: normalizeInt(raw?.defaults?.output?.resumeHistoryTurns, 3, 1, 100),
          chatHistoryFlushIntervalMs: normalizeInt(raw?.defaults?.output?.chatHistoryFlushIntervalMs, 250, 10, 10_000),
          turnOutputMinChunkChars: normalizeInt(raw?.defaults?.output?.turnOutputMinChunkChars, 160, 40, 8_000),
          turnOutputSoftChunkChars: normalizeInt(raw?.defaults?.output?.turnOutputSoftChunkChars, 280, 40, 8_000),
          liveSectionMaxLen: normalizeInt(raw?.defaults?.output?.liveSectionMaxLen, 1400, 200, 1900),
          liveSectionDelayMs: normalizeInt(raw?.defaults?.output?.liveSectionDelayMs, 250, 0, 10_000),
          discord: {
            replyToUser: Boolean(raw?.defaults?.output?.discord?.replyToUser ?? true),
            useLiveEdits: Boolean(raw?.defaults?.output?.discord?.useLiveEdits ?? true),
            statusEditIntervalMs: normalizeInt(raw?.defaults?.output?.discord?.statusEditIntervalMs, 500, 50, 10_000),
            statusMessageMaxLen: normalizeInt(raw?.defaults?.output?.discord?.statusMessageMaxLen, 1600, 200, 1900),
            toolProgressMode: normalizeChoice(raw?.defaults?.output?.discord?.toolProgressMode, ["off", "compact", "verbose"], "compact"),
            toolOutputTailLines: normalizeInt(raw?.defaults?.output?.discord?.toolOutputTailLines, 8, 1, 50),
            finalMessageMaxLen: normalizeInt(raw?.defaults?.output?.discord?.finalMessageMaxLen, 1600, 200, 1900),
            finalMessageDelayMs: normalizeInt(raw?.defaults?.output?.discord?.finalMessageDelayMs, 350, 0, 10_000),
          },
        },
      },
      channels: {
        discord: {
          enabled: Boolean(raw?.channels?.discord?.enabled),
          botToken: raw?.channels?.discord?.botToken || "",
          allowlist: raw?.channels?.discord?.allowlist || [],
          allowedChannels: raw?.channels?.discord?.allowedChannels || [],
        },
      },
    };
    if (JSON.stringify(raw || {}) !== JSON.stringify(normalized)) {
      this.writeConfig(normalized);
    }
    return normalized;
  }

  writeConfig(config) {
    writeJson(this.configPath, config, 0o600);
    try {
      fs.chmodSync(this.configPath, 0o600);
    } catch {
      // ignore platform-specific chmod failures
    }
  }

  getBindings() {
    const raw = readJson(this.bindingsPath, {});
    let changed = false;
    const normalized = {};

    for (const [key, binding] of Object.entries(raw || {})) {
      const policy = { ...(binding?.policyProfile || {}) };
      if (Object.prototype.hasOwnProperty.call(policy, "desktopSyncEnabled")) {
        delete policy.desktopSyncEnabled;
        changed = true;
      }
      const normalizedThreadAutoApprove = normalizeThreadAutoApproveByThreadId(policy.threadAutoApproveByThreadId);
      if (JSON.stringify(policy.threadAutoApproveByThreadId || {}) !== JSON.stringify(normalizedThreadAutoApprove)) {
        policy.threadAutoApproveByThreadId = normalizedThreadAutoApprove;
        changed = true;
      }
      const normalizedAutopilot = normalizeAutopilotPolicy(policy.autopilot);
      if (JSON.stringify(policy.autopilot || {}) !== JSON.stringify(normalizedAutopilot)) {
        policy.autopilot = normalizedAutopilot;
        changed = true;
      }
      normalized[key] = {
        ...binding,
        policyProfile: policy,
      };
    }

    if (changed) {
      writeJson(this.bindingsPath, normalized, 0o600);
    }

    return normalized;
  }

  listBindings() {
    return Object.values(this.getBindings());
  }

  getBinding(channel, chatId) {
    const bindings = this.getBindings();
    return bindings[keyOf(channel, chatId)] || null;
  }

  getBindingByThread(threadId) {
    const bindings = this.getBindings();
    return Object.values(bindings).find((binding) => binding.threadId === threadId) || null;
  }

  upsertBinding(binding) {
    const bindings = this.getBindings();
    const key = keyOf(binding.channel, binding.chatId);
    const existing = bindings[key] || {};
    const incomingPolicy = binding.policyProfile || {};
    const hasPolicyField = (field) => Object.prototype.hasOwnProperty.call(incomingPolicy, field);

    const policyProfile = {
      approvalMode: hasPolicyField("approvalMode")
        ? (incomingPolicy.approvalMode || "on-request")
        : (existing.policyProfile?.approvalMode || "on-request"),
      allowlist: hasPolicyField("allowlist")
        ? (incomingPolicy.allowlist || [])
        : (existing.policyProfile?.allowlist || []),
      autoApprove: hasPolicyField("autoApprove")
        ? Boolean(incomingPolicy.autoApprove)
        : Boolean(existing.policyProfile?.autoApprove ?? false),
      model: hasPolicyField("model")
        ? (incomingPolicy.model ?? null)
        : (existing.policyProfile?.model ?? null),
      reasoningEffort: hasPolicyField("reasoningEffort")
        ? (incomingPolicy.reasoningEffort ?? null)
        : (existing.policyProfile?.reasoningEffort ?? null),
      collaborationMode: hasPolicyField("collaborationMode")
        ? (incomingPolicy.collaborationMode ?? null)
        : (existing.policyProfile?.collaborationMode ?? null),
      skillsContext: hasPolicyField("skillsContext")
        ? (incomingPolicy.skillsContext ?? null)
        : (existing.policyProfile?.skillsContext ?? null),
      autopilot: hasPolicyField("autopilot")
        ? normalizeAutopilotPolicy(incomingPolicy.autopilot)
        : normalizeAutopilotPolicy(existing.policyProfile?.autopilot),
      threadAutoApproveByThreadId: normalizeThreadAutoApproveByThreadId(
        hasPolicyField("threadAutoApproveByThreadId")
          ? (incomingPolicy.threadAutoApproveByThreadId ?? {})
          : (existing.policyProfile?.threadAutoApproveByThreadId ?? {})
      ),
    };

    const next = {
      channel: binding.channel,
      chatId: String(binding.chatId),
      userId: binding.userId ? String(binding.userId) : existing.userId || null,
      threadId: Object.prototype.hasOwnProperty.call(binding, "threadId")
        ? (binding.threadId ? String(binding.threadId) : null)
        : (existing.threadId ?? null),
      workingDir: binding.workingDir || existing.workingDir || os.homedir(),
      policyProfile,
      updatedAt: nowIso(),
    };

    bindings[key] = next;
    writeJson(this.bindingsPath, bindings, 0o600);
    return next;
  }

  removeBinding(channel, chatId) {
    const bindings = this.getBindings();
    const key = keyOf(channel, chatId);
    delete bindings[key];
    writeJson(this.bindingsPath, bindings, 0o600);
  }

  setBindingThread(channel, chatId, threadId) {
    const binding = this.getBinding(channel, chatId);
    if (!binding) {
      return null;
    }

    binding.threadId = threadId;
    binding.updatedAt = nowIso();
    return this.upsertBinding(binding);
  }

  getPendingApprovals() {
    return readJson(this.pendingApprovalsPath, {});
  }

  createPendingApproval(record) {
    const approvals = this.getPendingApprovals();
    approvals[record.localRequestId] = {
      ...record,
      createdAt: nowIso(),
      status: "pending",
    };
    writeJson(this.pendingApprovalsPath, approvals, 0o600);
    return approvals[record.localRequestId];
  }

  resolvePendingApproval(localRequestId, resolution) {
    const approvals = this.getPendingApprovals();
    const existing = approvals[localRequestId];
    if (!existing) {
      return null;
    }

    approvals[localRequestId] = {
      ...existing,
      status: "resolved",
      resolvedAt: nowIso(),
      resolution,
    };
    writeJson(this.pendingApprovalsPath, approvals, 0o600);
    return approvals[localRequestId];
  }

  deletePendingApproval(localRequestId) {
    const approvals = this.getPendingApprovals();
    delete approvals[localRequestId];
    writeJson(this.pendingApprovalsPath, approvals, 0o600);
  }

  getSessions() {
    return readJson(this.sessionsPath, {});
  }

  upsertSession(session) {
    const sessions = this.getSessions();
    sessions[session.id] = {
      ...sessions[session.id],
      ...session,
      updatedAt: nowIso(),
    };
    writeJson(this.sessionsPath, sessions, 0o600);
    return sessions[session.id];
  }

  getAutopilotSessions() {
    const raw = readJson(this.autopilotSessionsPath, {});
    const normalized = normalizeAutopilotSessions(raw);
    if (JSON.stringify(raw || {}) !== JSON.stringify(normalized)) {
      writeJson(this.autopilotSessionsPath, normalized, 0o600);
    }
    return normalized;
  }

  getAutopilotSession(bindingKey) {
    const sessions = this.getAutopilotSessions();
    return sessions[String(bindingKey || "").trim()] || null;
  }

  upsertAutopilotSession(session) {
    const key = String(session?.bindingKey || "").trim();
    if (!key) {
      return null;
    }
    const sessions = this.getAutopilotSessions();
    const next = normalizeAutopilotSessions({
      ...sessions,
      [key]: {
        ...sessions[key],
        ...session,
        bindingKey: key,
        updatedAt: nowIso(),
      },
    });
    writeJson(this.autopilotSessionsPath, next, 0o600);
    return next[key];
  }

  deleteAutopilotSession(bindingKey) {
    const key = String(bindingKey || "").trim();
    if (!key) {
      return;
    }
    const sessions = this.getAutopilotSessions();
    delete sessions[key];
    writeJson(this.autopilotSessionsPath, sessions, 0o600);
  }

  appendAudit(event) {
    const line = JSON.stringify({
      auditId: randomUUID(),
      timestamp: nowIso(),
      ...event,
    });
    this.auditBuffer.push(line);
    this.#scheduleAuditFlush();
  }

  readAudit(limit = 100) {
    const pendingLines = [
      ...this.auditInFlight.flatMap((batch) => batch),
      ...this.auditBuffer,
    ];
    try {
      const content = fs.readFileSync(this.auditPath, "utf8");
      const persistedLines = content.trim().split("\n").filter(Boolean);
      const mergedLines = [...persistedLines, ...pendingLines];
      const parsed = [];
      const seenAuditIds = new Set();
      for (const line of mergedLines) {
        const record = parseAuditLine(line);
        if (!record) {
          continue;
        }
        const id = record.auditId ? String(record.auditId) : "";
        if (id && seenAuditIds.has(id)) {
          continue;
        }
        if (id) {
          seenAuditIds.add(id);
        }
        parsed.push(record);
      }
      return parsed.slice(-limit);
    } catch {
      return pendingLines
        .map((line) => parseAuditLine(line))
        .filter(Boolean)
        .slice(-limit);
    }
  }

  markDeliveryOnce(key, { ttlMs = DELIVERY_DEDUPE_TTL_MS, maxEntries = DELIVERY_DEDUPE_MAX_ENTRIES } = {}) {
    const dedupeKey = String(key || "").trim();
    if (!dedupeKey) {
      return true;
    }

    const nowMs = Date.now();
    try {
      if (!this.deliveryDedupeCache) {
        this.deliveryDedupeCache = readJson(this.deliveryDedupePath, {});
      }
      const normalized = normalizeDeliveryMap(this.deliveryDedupeCache, { nowMs, ttlMs, maxEntries });
      if (Object.prototype.hasOwnProperty.call(normalized, dedupeKey)) {
        this.deliveryDedupeCache = normalized;
        return false;
      }
      normalized[dedupeKey] = nowMs;
      const finalMap = normalizeDeliveryMap(normalized, { nowMs, ttlMs, maxEntries });
      this.deliveryDedupeCache = finalMap;
      writeJson(this.deliveryDedupePath, finalMap, 0o600);
      return true;
    } catch (error) {
      console.warn(`[state-store] failed to persist delivery dedupe key: ${error.message}`);
      return true;
    }
  }

  getChannelCursor(channel, chatId) {
    const key = keyOf(channel, chatId);
    if (!this.channelCursorCache) {
      this.channelCursorCache = normalizeCursorMap(readJson(this.channelCursorPath, {}));
    }
    return this.channelCursorCache[key] || null;
  }

  setChannelCursor(channel, chatId, cursor) {
    const key = keyOf(channel, chatId);
    const value = String(cursor || "").trim();
    if (!key || !value) {
      return null;
    }

    try {
      if (!this.channelCursorCache) {
        this.channelCursorCache = normalizeCursorMap(readJson(this.channelCursorPath, {}));
      }
      const next = normalizeCursorMap({
        ...this.channelCursorCache,
        [key]: value,
      });
      this.channelCursorCache = next;
      writeJson(this.channelCursorPath, next, 0o600);
      return value;
    } catch (error) {
      console.warn(`[state-store] failed to persist channel cursor: ${error.message}`);
      return null;
    }
  }

  async flush() {
    await this.#flushAuditBuffer({ force: true });
  }

  #scheduleAuditFlush() {
    if (this.auditFlushTimer) {
      return;
    }
    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = null;
      this.#flushAuditBuffer().catch((error) => {
        console.warn(`[state-store] failed to flush audit buffer: ${error.message}`);
      });
    }, AUDIT_FLUSH_INTERVAL_MS);
  }

  async #flushAuditBuffer({ force = false } = {}) {
    if (this.auditFlushTimer && force) {
      clearTimeout(this.auditFlushTimer);
      this.auditFlushTimer = null;
    }
    if (!this.auditBuffer.length) {
      if (force) {
        await this.auditFlushChain.catch(() => {});
      }
      return;
    }
    const batch = this.auditBuffer.splice(0, this.auditBuffer.length);
    const payload = `${batch.join("\n")}\n`;
    this.auditInFlight.push(batch);

    const writeTask = this.auditFlushChain
      .catch(() => {})
      .then(() => fsp.appendFile(this.auditPath, payload, { encoding: "utf8", mode: 0o600 }));
    this.auditFlushChain = writeTask.catch(() => {});

    try {
      await writeTask;
    } catch (error) {
      if (force) {
        try {
          fs.appendFileSync(this.auditPath, payload, { encoding: "utf8", mode: 0o600 });
          return;
        } catch (syncError) {
          console.warn(`[state-store] failed to force-flush audit buffer: ${syncError.message}`);
        }
      } else {
        console.warn(`[state-store] failed to flush audit buffer: ${error.message}`);
      }
      this.auditBuffer = [...batch, ...this.auditBuffer];
      this.#scheduleAuditFlush();
    } finally {
      const idx = this.auditInFlight.indexOf(batch);
      if (idx >= 0) {
        this.auditInFlight.splice(idx, 1);
      }
    }
  }
}
