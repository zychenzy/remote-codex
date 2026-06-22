import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const DELIVERY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_DEDUPE_MAX_ENTRIES = 5_000;
const CHANNEL_CURSOR_MAX_ENTRIES = 5_000;
// ponytail: sync append + size rotation, drop async staging. 50 MB ceiling, keep 2 old generations.
const AUDIT_MAX_BYTES = 50 * 1024 * 1024;
const AUDIT_ROTATE_GENERATIONS = 2;
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function isWritableDir(dir) {
  try {
    ensureDir(dir);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (error) {
    // L1: do not silently relocate state; surface why the preferred dir was rejected.
    console.warn(`[state-store] directory not writable, falling back: ${dir}: ${error.message}`);
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
  // L2: unique temp suffix so concurrent processes never collide on the staging file.
  const temp = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  // H3-durability: fsync the data before the rename so a crash cannot land the
  // rename ahead of the bytes (which would leave a truncated/empty file).
  const fd = fs.openSync(temp, "w", mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, filePath);
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dirFd = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; ignore.
  }
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

// S2: thread auto-approve and thread plan-mode share byte-identical normalization.
function normalizeBooleanByThreadId(raw = {}, { maxEntries = 500 } = {}) {
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
    // ponytail: single legal value today; field gates a future tool-input enum.
    toolInputStrategy: "recommended_only",
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

function normalizeConfig(raw = {}) {
  const defaults = {
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
  };
  // CONTRACT workspace-root: accept an optional defaults.workspaceRoot (string) when present.
  if (typeof raw?.defaults?.workspaceRoot === "string" && raw.defaults.workspaceRoot.trim()) {
    defaults.workspaceRoot = raw.defaults.workspaceRoot;
  }
  return {
    runtime: {
      appServer: {
        command: raw?.runtime?.appServer?.command || "codex",
        args: raw?.runtime?.appServer?.args || ["app-server", "--listen", "stdio://"],
      },
    },
    defaults,
    channels: {
      discord: {
        enabled: Boolean(raw?.channels?.discord?.enabled),
        botToken: raw?.channels?.discord?.botToken || "",
        allowlist: raw?.channels?.discord?.allowlist || [],
        allowedChannels: raw?.channels?.discord?.allowedChannels || [],
      },
    },
  };
}

function normalizeBinding(binding) {
  const policy = { ...(binding?.policyProfile || {}) };
  // Drop a long-removed field if it lingers on disk.
  delete policy.desktopSyncEnabled;
  policy.threadAutoApproveByThreadId = normalizeBooleanByThreadId(policy.threadAutoApproveByThreadId);
  policy.threadPlanModeByThreadId = normalizeBooleanByThreadId(policy.threadPlanModeByThreadId);
  policy.autopilot = normalizeAutopilotPolicy(policy.autopilot);
  const normalized = {
    ...binding,
    policyProfile: policy,
  };
  // CONTRACT workspace-root: preserve a string workspaceRoot if present, drop otherwise.
  if (typeof binding?.workspaceRoot === "string" && binding.workspaceRoot.trim()) {
    normalized.workspaceRoot = binding.workspaceRoot;
  } else {
    delete normalized.workspaceRoot;
  }
  return normalized;
}

function normalizeBindings(raw = {}) {
  const normalized = {};
  for (const [key, binding] of Object.entries(raw || {})) {
    normalized[key] = normalizeBinding(binding);
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
    this.deliveryDedupeCache = null;
    this.channelCursorCache = null;

    ensureDir(this.baseDir);
    ensureDir(this.dataDir);
    ensureDir(this.runtimeDir);
    ensureDir(this.logsDir);
  }

  // Explicit, run-once migration: rewrite on-disk files into normalized shape.
  // Reads stay pure (no write side effects); call this at init to migrate.
  migrate() {
    const rawConfig = readJson(this.configPath, {});
    const normalizedConfig = normalizeConfig(rawConfig);
    if (JSON.stringify(rawConfig || {}) !== JSON.stringify(normalizedConfig)) {
      this.writeConfig(normalizedConfig);
    }

    const rawBindings = readJson(this.bindingsPath, {});
    const normalizedBindings = normalizeBindings(rawBindings);
    if (JSON.stringify(rawBindings || {}) !== JSON.stringify(normalizedBindings)) {
      writeJson(this.bindingsPath, normalizedBindings, 0o600);
    }

    const rawAutopilot = readJson(this.autopilotSessionsPath, {});
    const normalizedAutopilot = normalizeAutopilotSessions(rawAutopilot);
    if (JSON.stringify(rawAutopilot || {}) !== JSON.stringify(normalizedAutopilot)) {
      writeJson(this.autopilotSessionsPath, normalizedAutopilot, 0o600);
    }
  }

  readConfig() {
    // H5-config: normalize for use only; never write back from a read.
    return normalizeConfig(readJson(this.configPath, {}));
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
    // H5-config: normalize for use only; never write back from a read.
    return normalizeBindings(readJson(this.bindingsPath, {}));
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
      threadAutoApproveByThreadId: normalizeBooleanByThreadId(
        hasPolicyField("threadAutoApproveByThreadId")
          ? (incomingPolicy.threadAutoApproveByThreadId ?? {})
          : (existing.policyProfile?.threadAutoApproveByThreadId ?? {})
      ),
      threadPlanModeByThreadId: normalizeBooleanByThreadId(
        hasPolicyField("threadPlanModeByThreadId")
          ? (incomingPolicy.threadPlanModeByThreadId ?? {})
          : (existing.policyProfile?.threadPlanModeByThreadId ?? {})
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

    // CONTRACT workspace-root: preserve a string workspaceRoot across upserts.
    const incomingWorkspaceRoot = Object.prototype.hasOwnProperty.call(binding, "workspaceRoot")
      ? binding.workspaceRoot
      : existing.workspaceRoot;
    if (typeof incomingWorkspaceRoot === "string" && incomingWorkspaceRoot.trim()) {
      next.workspaceRoot = incomingWorkspaceRoot;
    }

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
    // H5-config: normalize for use only; never write back from a read.
    return normalizeAutopilotSessions(readJson(this.autopilotSessionsPath, {}));
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
    // S1 + H7: synchronous append is more durable than the old buffered async
    // staging, and far simpler. Rotate by size before the line lands.
    const line = JSON.stringify({
      auditId: randomUUID(),
      timestamp: nowIso(),
      ...event,
    });
    this.#rotateAuditIfNeeded();
    try {
      fs.appendFileSync(this.auditPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(`[state-store] failed to append audit event: ${error.message}`);
    }
  }

  readAudit(limit = 100) {
    // Single source of truth now lives on disk, so no dedupe/merge is needed.
    try {
      const content = fs.readFileSync(this.auditPath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => parseAuditLine(line))
        .filter(Boolean)
        .slice(-limit);
    } catch {
      return [];
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

  // ponytail: kept as a no-op stub; appends are synchronous so there is nothing
  // to drain. daemon-app.js still awaits store.flush().
  async flush() {}

  #rotateAuditIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.auditPath).size;
    } catch {
      return; // No file yet: nothing to rotate.
    }
    if (size < AUDIT_MAX_BYTES) {
      return;
    }
    try {
      // Shift generations: audit.jsonl.1 -> .2, then audit.jsonl -> .1.
      for (let gen = AUDIT_ROTATE_GENERATIONS - 1; gen >= 1; gen -= 1) {
        const from = `${this.auditPath}.${gen}`;
        const to = `${this.auditPath}.${gen + 1}`;
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }
      fs.renameSync(this.auditPath, `${this.auditPath}.1`);
    } catch (error) {
      console.warn(`[state-store] failed to rotate audit log: ${error.message}`);
    }
  }
}
