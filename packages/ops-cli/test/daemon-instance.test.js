import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimDaemonLock,
  readPidFile,
  restartDaemon,
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

test("claimDaemonLock never SIGTERMs a live lock owner with an unknown token", async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "daemon.pid");
  const lockFile = path.join(dir, "daemon.lock");
  // Lock held by a live, unrelated/recycled PID we have no prior token for.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 555, token: "stranger" }), "utf8");

  const running = new Set([555]);
  const signals = [];

  await assert.rejects(
    claimDaemonLock({
      pidFile,
      lockFile,
      currentPid: 999,
      sleepFn: async () => {},
      takeoverTimeoutMs: 5,
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
    }),
    /failed to acquire daemon lock before timeout/
  );

  // The stranger PID must not have been signalled, and its lock must survive.
  assert.deepEqual(signals, []);
  assert.match(fs.readFileSync(lockFile, "utf8"), /"pid":\s*555/);
});

test("claimDaemonLock takes over a live owner only when the prior token matches", async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "daemon.pid");
  const lockFile = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 666, token: "mine-prior" }), "utf8");

  const running = new Set([666]);
  const signals = [];

  const lock = await claimDaemonLock({
    pidFile,
    lockFile,
    currentPid: 777,
    priorToken: "mine-prior",
    tokenFn: () => "fresh-token",
    sleepFn: async () => {},
    takeoverTimeoutMs: 500,
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
  });

  assert.deepEqual(signals, [[666, "SIGTERM"]]);
  assert.equal(lock.token, "fresh-token");
  assert.match(fs.readFileSync(lockFile, "utf8"), /"pid": 777/);
  assert.match(fs.readFileSync(lockFile, "utf8"), /"token": "fresh-token"/);
});

test("lock.release() does not clobber a lock already replaced by another owner", async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "daemon.pid");
  const lockFile = path.join(dir, "daemon.lock");

  const lock = await claimDaemonLock({
    pidFile,
    lockFile,
    currentPid: 1000,
    tokenFn: () => "token-a",
    sleepFn: async () => {},
    takeoverTimeoutMs: 500,
    pollIntervalMs: 1,
    killFn() {},
  });

  // A different daemon has since replaced the lock record.
  const replacement = JSON.stringify({ pid: 2000, token: "token-b" });
  fs.writeFileSync(lockFile, replacement, "utf8");

  lock.release();

  // Our release must leave the newer owner's lock untouched.
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(fs.readFileSync(lockFile, "utf8"), replacement);
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
