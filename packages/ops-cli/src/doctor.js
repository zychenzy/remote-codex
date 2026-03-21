import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function runDoctor({ store, spawn = spawnSync } = {}) {
  const findings = [];

  const codexVersion = spawn("codex", ["--version"], { encoding: "utf8" });
  if (codexVersion.status !== 0) {
    findings.push({ level: "error", message: "codex CLI not available in PATH" });
  } else {
    findings.push({ level: "info", message: `codex detected: ${codexVersion.stdout.trim()}` });
  }

  const codexLogin = spawn("codex", ["login", "status"], { encoding: "utf8" });
  if (codexLogin.status !== 0) {
    findings.push({ level: "warn", message: "codex login status unavailable" });
  } else {
    const statusText = String(codexLogin.stdout || "").trim() || "unknown";
    findings.push({ level: "info", message: `codex auth: ${statusText}` });
    if (!/logged in/i.test(statusText)) {
      findings.push({ level: "warn", message: "codex auth appears to be logged out" });
    }
  }

  try {
    const stat = fs.statSync(store.configPath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      findings.push({ level: "warn", message: `config mode is ${mode.toString(8)}, expected 600` });
    } else {
      findings.push({ level: "info", message: "config mode is 600" });
    }
  } catch {
    findings.push({ level: "warn", message: "config file missing; run setup" });
  }

  const bindings = store.listBindings();
  findings.push({ level: "info", message: `bindings: ${bindings.length}` });

  const pending = Object.keys(store.getPendingApprovals()).length;
  findings.push({ level: "info", message: `pending approvals: ${pending}` });

  return findings;
}
