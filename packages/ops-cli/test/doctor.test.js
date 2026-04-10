import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../src/doctor.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-doctor-"));
}

test("doctor reports codex login status when available", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });

  const findings = runDoctor({
    store: {
      configPath,
      listBindings: () => [],
      getPendingApprovals: () => ({}),
    },
    spawn: (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key === "codex --version") {
        return { status: 0, stdout: "codex 1.2.3\n" };
      }
      if (key === "codex login status") {
        return { status: 0, stdout: "Logged in using ChatGPT\n" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });

  assert.equal(findings.some((item) => item.message.includes("codex detected: codex 1.2.3")), true);
  assert.equal(findings.some((item) => item.message.includes("codex auth: Logged in using ChatGPT")), true);
});

test("doctor warns when codex login status is unavailable", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });

  const findings = runDoctor({
    store: {
      configPath,
      listBindings: () => [],
      getPendingApprovals: () => ({}),
    },
    spawn: (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key === "codex --version") {
        return { status: 0, stdout: "codex 1.2.3\n" };
      }
      if (key === "codex login status") {
        return { status: 1, stdout: "", stderr: "failed" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });

  assert.equal(findings.some((item) => item.message.includes("codex login status unavailable")), true);
});

test("doctor errors when multiple reco daemons are running", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "config.json");
  const runtimeDir = path.join(dir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, "status.json"), JSON.stringify({ running: true, pid: 222 }), "utf8");

  const findings = runDoctor({
    store: {
      configPath,
      runtimeDir,
      listBindings: () => [],
      getPendingApprovals: () => ({}),
    },
    spawn: (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key === "codex --version") {
        return { status: 0, stdout: "codex 1.2.3\n" };
      }
      if (key === "codex login status") {
        return { status: 0, stdout: "Logged in using ChatGPT\n" };
      }
      if (key === "pgrep -fal packages/ops-cli/src/cli.js daemon-run") {
        return {
          status: 0,
          stdout: [
            "111 /opt/homebrew/bin/node /Users/czy/auto/packages/ops-cli/src/cli.js daemon-run",
            "222 /opt/homebrew/bin/node /Users/czy/auto/packages/ops-cli/src/cli.js daemon-run",
            "",
          ].join("\n"),
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });

  assert.equal(
    findings.some((item) => item.level === "error" && item.message.includes("multiple reco daemon processes detected (2: 111, 222)")),
    true
  );
  assert.equal(findings.some((item) => item.message.includes("runtime status pid: 222")), true);
});
