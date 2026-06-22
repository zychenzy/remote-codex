import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

function sleep(ms, { setTimeoutFn = globalThis.setTimeout } = {}) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

export function isPidRunning(pid, { killFn = process.kill } = {}) {
  if (!pid) {
    return false;
  }
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(pidFile, { fsModule = fs } = {}) {
  try {
    return Number(fsModule.readFileSync(pidFile, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function readLockRecord(lockFile, { fsModule = fs } = {}) {
  try {
    const raw = fsModule.readFileSync(lockFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      pid: Number(parsed?.pid) || 0,
      token: parsed?.token ? String(parsed.token) : "",
    };
  } catch {
    return { pid: 0, token: "" };
  }
}

// Remove the lock only if it still matches what we observed (pid + token), so a
// concurrent claimant that has already replaced the record is never clobbered.
// ponytail: POSIX has no atomic compare-and-unlink, so a sub-millisecond race
// remains between the re-read and rmSync; the token check makes a stomp require
// an exact pid+token collision, which randomUUID makes effectively impossible.
function clearIfMatches(lockFile, observed, { fsModule = fs } = {}) {
  const current = readLockRecord(lockFile, { fsModule });
  if (!current.pid && !current.token) {
    // already gone or unowned
    return true;
  }
  if (observed.token) {
    if (current.token !== observed.token) {
      return false;
    }
  } else if (current.pid !== observed.pid) {
    return false;
  }
  fsModule.rmSync(lockFile, { force: true });
  return true;
}

async function waitForExit(pid, {
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  killFn = process.kill,
  sleepFn = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid, { killFn })) {
      return true;
    }
    await sleepFn(pollIntervalMs);
  }
  return !isPidRunning(pid, { killFn });
}

export async function stopExistingDaemon(pid, {
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  killFn = process.kill,
  sleepFn = sleep,
} = {}) {
  if (!pid || !isPidRunning(pid, { killFn })) {
    return false;
  }
  killFn(pid, "SIGTERM");
  const stopped = await waitForExit(pid, {
    timeoutMs,
    pollIntervalMs,
    killFn,
    sleepFn,
  });
  if (!stopped) {
    throw new Error(`existing daemon pid ${pid} did not exit after SIGTERM`);
  }
  return true;
}

export async function restartDaemon(existingPid, startFn, {
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  killFn = process.kill,
  sleepFn = sleep,
} = {}) {
  if (existingPid && isPidRunning(existingPid, { killFn })) {
    await stopExistingDaemon(existingPid, {
      timeoutMs,
      pollIntervalMs,
      killFn,
      sleepFn,
    });
  }
  return startFn();
}

export async function claimDaemonLock({
  pidFile,
  lockFile,
  currentPid = process.pid,
  priorToken = "",
  tokenFn = crypto.randomUUID,
  fsModule = fs,
  killFn = process.kill,
  sleepFn = sleep,
  takeoverTimeoutMs = 10_000,
  pollIntervalMs = 100,
} = {}) {
  const recordedPid = readPidFile(pidFile, { fsModule });
  if (recordedPid && recordedPid !== currentPid) {
    await stopExistingDaemon(recordedPid, {
      timeoutMs: takeoverTimeoutMs,
      pollIntervalMs,
      killFn,
      sleepFn,
    });
  }

  const token = tokenFn();
  const data = JSON.stringify({
    pid: currentPid,
    token,
    acquiredAt: new Date().toISOString(),
  }, null, 2);
  const owned = { pid: currentPid, token };
  const acquire = () => ({
    token,
    release() {
      clearIfMatches(lockFile, owned, { fsModule });
    },
  });

  const deadline = Date.now() + takeoverTimeoutMs;
  while (true) {
    try {
      fsModule.writeFileSync(lockFile, data, { flag: "wx", mode: 0o600 });
      return acquire();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const owner = readLockRecord(lockFile, { fsModule });
    if (!owner.pid) {
      // unowned record (corrupt/empty): safe to clear since we just observed it
      clearIfMatches(lockFile, owner, { fsModule });
    } else if (owner.pid === currentPid) {
      return acquire();
    } else if (!isPidRunning(owner.pid, { killFn })) {
      // dead owner: only clear the exact record we just observed as dead
      clearIfMatches(lockFile, owner, { fsModule });
    } else if (priorToken && owner.token === priorToken) {
      // alive owner is a prior incarnation of ours (token matches): safe to replace
      await stopExistingDaemon(owner.pid, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        pollIntervalMs,
        killFn,
        sleepFn,
      });
      clearIfMatches(lockFile, owner, { fsModule });
    }
    // else: alive owner with an unknown token. It may be an unrelated (possibly
    // recycled) PID, so we never SIGTERM it; wait and retry until the deadline.

    if (Date.now() >= deadline) {
      throw new Error("failed to acquire daemon lock before timeout");
    }
    await sleepFn(pollIntervalMs);
  }
}
