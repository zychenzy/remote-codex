import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimDaemonLock,
  parseDaemonRunPids,
  readPidFile,
  restartDaemon,
  stopDaemonRunPids,
} from "../src/daemon-instance.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-daemon-instance-"));
}

test("claimDaemonLock stops the recorded daemon before taking ownership", async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "daemon.pid");
  const lockFile = path.join(dir, "daemon.lock");
  fs.writeFileSync(pidFile, "111", "utf8");

  const running = new Set([111]);
  const signals = [];

  const lock = await claimDaemonLock({
    pidFile,
    lockFile,
    currentPid: 222,
    killFn(pid, signal = 0) {
      if (signal === 0) {
        if (!running.has(pid)) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      signals.push([pid, signal]);
      running.delete(pid);
    },
    sleepFn: async () => {},
    takeoverTimeoutMs: 500,
    pollIntervalMs: 1,
  });

  assert.deepEqual(signals, [[111, "SIGTERM"]]);
  assert.equal(readPidFile(pidFile), 111);
  assert.match(fs.readFileSync(lockFile, "utf8"), /"pid": 222/);

  lock.release();
  assert.equal(fs.existsSync(lockFile), false);
});

test("claimDaemonLock clears a stale lock owned by a dead pid", async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "daemon.pid");
  const lockFile = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 333 }), "utf8");

  const lock = await claimDaemonLock({
    pidFile,
    lockFile,
    currentPid: 444,
    killFn(_pid, signal = 0) {
      if (signal === 0) {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      }
      throw new Error("unexpected signal");
    },
    sleepFn: async () => {},
    takeoverTimeoutMs: 500,
    pollIntervalMs: 1,
  });

  assert.match(fs.readFileSync(lockFile, "utf8"), /"pid": 444/);

  lock.release();
  assert.equal(fs.existsSync(lockFile), false);
});

test("restartDaemon does not start a replacement until the existing daemon exits", async () => {
  const running = new Set([111]);
  const signals = [];
  let started = 0;

  await assert.rejects(
    restartDaemon(111, async () => {
      started += 1;
    }, {
      timeoutMs: 5,
      pollIntervalMs: 1,
      killFn(pid, signal = 0) {
        if (signal === 0) {
          if (!running.has(pid)) {
            const error = new Error("no such process");
            error.code = "ESRCH";
            throw error;
          }
          return;
        }
        signals.push([pid, signal]);
      },
      sleepFn: async () => {},
    }),
    /did not exit after SIGTERM/
  );

  assert.deepEqual(signals, [[111, "SIGTERM"]]);
  assert.equal(started, 0);
});

test("restartDaemon starts replacement after the existing daemon exits", async () => {
  const running = new Set([111]);
  const signals = [];
  let started = 0;

  await restartDaemon(111, async () => {
    started += 1;
  }, {
    timeoutMs: 50,
    pollIntervalMs: 1,
    killFn(pid, signal = 0) {
      if (signal === 0) {
        if (!running.has(pid)) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      signals.push([pid, signal]);
      running.delete(pid);
    },
    sleepFn: async () => {},
  });

  assert.deepEqual(signals, [[111, "SIGTERM"]]);
  assert.equal(started, 1);
});

test("parseDaemonRunPids finds repo daemon-run processes and ignores other node commands", () => {
  const scriptPath = "/Users/czy/auto/packages/ops-cli/src/cli.js";
  const output = [
    " 111 /opt/homebrew/bin/node /Users/czy/auto/packages/ops-cli/src/cli.js daemon-run",
    " 112 /opt/homebrew/bin/node /Users/czy/auto/packages/ops-cli/src/cli.js start",
    " 113 node /opt/homebrew/bin/codex app-server --listen stdio://",
    " 114 /opt/homebrew/bin/node /Users/czy/other/packages/ops-cli/src/cli.js daemon-run",
    " 115 /opt/homebrew/bin/node /Users/czy/auto/packages/ops-cli/src/cli.js daemon-run",
  ].join("\n");

  assert.deepEqual(parseDaemonRunPids(output, { scriptPath, currentPid: 115 }), [111]);
});

test("stopDaemonRunPids terminates unique daemon pids", async () => {
  const running = new Set([111, 222]);
  const signals = [];

  const stopped = await stopDaemonRunPids([111, 111, 222], {
    timeoutMs: 50,
    pollIntervalMs: 1,
    killFn(pid, signal = 0) {
      if (signal === 0) {
        if (!running.has(pid)) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      signals.push([pid, signal]);
      running.delete(pid);
    },
    sleepFn: async () => {},
  });

  assert.deepEqual(stopped, [111, 222]);
  assert.deepEqual(signals, [[111, "SIGTERM"], [222, "SIGTERM"]]);
});
