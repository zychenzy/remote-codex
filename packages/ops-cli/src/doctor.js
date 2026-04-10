import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function parsePidList(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2],
      };
    })
    .filter(Boolean);
}

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

  const daemonMatches = spawn("pgrep", ["-fal", "packages/ops-cli/src/cli.js daemon-run"], { encoding: "utf8" });
  if (daemonMatches.status === 0) {
    const daemons = parsePidList(daemonMatches.stdout);
    if (daemons.length > 1) {
      const pids = daemons.map((entry) => entry.pid).join(", ");
      findings.push({
        level: "error",
        message: `multiple reco daemon processes detected (${daemons.length}: ${pids}); this can duplicate turns and mix codex auth state`,
      });
    } else if (daemons.length === 1) {
      findings.push({ level: "info", message: `reco daemon pid: ${daemons[0].pid}` });
    }
  }

  const statusPath = store.runtimeDir ? path.join(store.runtimeDir, "status.json") : null;
  if (statusPath) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      if (status?.running && status?.pid) {
        findings.push({ level: "info", message: `runtime status pid: ${status.pid}` });
      }
    } catch {
      // ignore missing or unreadable runtime status
    }
  }

  return findings;
}
