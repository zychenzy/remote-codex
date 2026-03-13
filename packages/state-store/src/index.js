import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    this.auditPath = path.join(this.dataDir, "audit.jsonl");

    ensureDir(this.baseDir);
    ensureDir(this.dataDir);
    ensureDir(this.runtimeDir);
    ensureDir(this.logsDir);
  }

  readConfig() {
    return readJson(this.configPath, {
      runtime: {
        appServer: {
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
        },
      },
      defaults: {
        workingDir: process.cwd(),
        approvalMode: "on-request",
      },
      channels: {
        telegram: {
          enabled: false,
          botToken: "",
          allowlist: [],
        },
        discord: {
          enabled: false,
          botToken: "",
          allowlist: [],
          allowedChannels: [],
        },
      },
      security: {
        desktopSyncEnabled: false,
      },
    });
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
    return readJson(this.bindingsPath, {});
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

    const policyProfile = {
      approvalMode: binding.policyProfile?.approvalMode || existing.policyProfile?.approvalMode || "on-request",
      allowlist: binding.policyProfile?.allowlist || existing.policyProfile?.allowlist || [],
      autoApprove: Boolean(binding.policyProfile?.autoApprove ?? existing.policyProfile?.autoApprove ?? false),
      desktopSyncEnabled: Boolean(binding.policyProfile?.desktopSyncEnabled ?? existing.policyProfile?.desktopSyncEnabled ?? false),
    };

    const next = {
      channel: binding.channel,
      chatId: String(binding.chatId),
      userId: binding.userId ? String(binding.userId) : existing.userId || null,
      threadId: binding.threadId ?? existing.threadId ?? null,
      workingDir: binding.workingDir || existing.workingDir || process.cwd(),
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

  appendAudit(event) {
    const line = JSON.stringify({ timestamp: nowIso(), ...event });
    fs.appendFileSync(this.auditPath, `${line}\n`, { mode: 0o600 });
  }

  readAudit(limit = 100) {
    try {
      const content = fs.readFileSync(this.auditPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
