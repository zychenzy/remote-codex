import fs from "node:fs";
import process from "node:process";
import { execFileSync } from "node:child_process";

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

function readLockOwner(lockFile, { fsModule = fs } = {}) {
  try {
    const raw = fsModule.readFileSync(lockFile, "utf8");
    const parsed = JSON.parse(raw);
    return Number(parsed?.pid) || 0;
  } catch {
    return 0;
  }
}

function clearIfOwned(lockFile, ownerPid, { fsModule = fs } = {}) {
  const currentOwner = readLockOwner(lockFile, { fsModule });
  if (currentOwner && currentOwner !== ownerPid) {
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

export function parseDaemonRunPids(psOutput, {
  scriptPath,
  currentPid = process.pid,
} = {}) {
  const scriptNeedle = String(scriptPath || "").trim();
  if (!scriptNeedle) {
    return [];
  }
  const current = Number(currentPid) || 0;
  const pids = [];
  for (const line of String(psOutput || "").split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]) || 0;
    const command = match[2] || "";
    if (!pid || pid === current) {
      continue;
    }
    if (!command.includes(scriptNeedle) || !/\bdaemon-run\b/.test(command)) {
      continue;
    }
    pids.push(pid);
  }
  return [...new Set(pids)];
}

export function listDaemonRunPids({
  scriptPath,
  currentPid = process.pid,
  execFileSyncFn = execFileSync,
  throwOnError = false,
} = {}) {
  try {
    const output = execFileSyncFn("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return parseDaemonRunPids(output, { scriptPath, currentPid });
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    return [];
  }
}

export async function stopDaemonRunPids(pids, {
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  killFn = process.kill,
  sleepFn = sleep,
} = {}) {
  const stopped = [];
  for (const pid of [...new Set((pids || []).map((value) => Number(value) || 0).filter(Boolean))]) {
    const didStop = await stopExistingDaemon(pid, {
      timeoutMs,
      pollIntervalMs,
      killFn,
      sleepFn,
    });
    if (didStop) {
      stopped.push(pid);
    }
  }
  return stopped;
}

export async function claimDaemonLock({
  pidFile,
  lockFile,
  currentPid = process.pid,
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

  const deadline = Date.now() + takeoverTimeoutMs;
  while (true) {
    try {
      const fd = fsModule.openSync(lockFile, "wx", 0o600);
      fsModule.writeFileSync(fd, JSON.stringify({
        pid: currentPid,
        acquiredAt: new Date().toISOString(),
      }, null, 2));
      fsModule.closeSync(fd);
      return {
        release() {
          clearIfOwned(lockFile, currentPid, { fsModule });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const ownerPid = readLockOwner(lockFile, { fsModule });
    if (!ownerPid) {
      fsModule.rmSync(lockFile, { force: true });
    } else if (ownerPid === currentPid) {
      return {
        release() {
          clearIfOwned(lockFile, currentPid, { fsModule });
        },
      };
    } else if (!isPidRunning(ownerPid, { killFn })) {
      fsModule.rmSync(lockFile, { force: true });
    } else {
      await stopExistingDaemon(ownerPid, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        pollIntervalMs,
        killFn,
        sleepFn,
      });
      clearIfOwned(lockFile, ownerPid, { fsModule });
    }

    if (Date.now() >= deadline) {
      throw new Error("failed to acquire daemon lock before timeout");
    }
    await sleepFn(pollIntervalMs);
  }
}
