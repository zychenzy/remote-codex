#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";

import { StateStore } from "../../state-store/src/index.js";
import { AppServerRuntime } from "../../core-runtime/src/index.js";
import { DaemonApp } from "./daemon-app.js";
import { runDoctor } from "./doctor.js";
import {
  getArgValue,
  splitCsv,
  tailFile,
  toBoolean,
  resolveBindTargets,
} from "./utils.js";

function resolveBaseDir() {
  if (process.env.IM_CODEX_HOME) {
    return process.env.IM_CODEX_HOME;
  }

  const preferred = path.join(os.homedir(), ".im-codex-tool");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(process.cwd(), ".im-codex-tool");
  }
}

const BASE_DIR = resolveBaseDir();
const store = new StateStore({ baseDir: BASE_DIR });

const PID_FILE = path.join(store.runtimeDir, "daemon.pid");
const STATUS_FILE = path.join(store.runtimeDir, "status.json");

function writeStatus(status) {
  const temp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(status, null, 2));
  fs.renameSync(temp, STATUS_FILE);
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return { running: false };
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return 0;
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdSetup() {
  const existing = store.readConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const workingDir = (await rl.question(`Default working directory [${existing.defaults.workingDir}]: `)).trim() || existing.defaults.workingDir;
  const approvalMode = (await rl.question(`Default approval mode (on-request|never|untrusted) [${existing.defaults.approvalMode}]: `)).trim() || existing.defaults.approvalMode;

  const telegramEnabled = toBoolean((await rl.question(`Enable Telegram? (y/n) [${existing.channels.telegram.enabled ? "y" : "n"}]: `)).trim() || (existing.channels.telegram.enabled ? "y" : "n"));
  const telegramToken = telegramEnabled
    ? ((await rl.question(`Telegram bot token [${existing.channels.telegram.botToken ? "***" : ""}]: `)).trim() || existing.channels.telegram.botToken)
    : "";
  const telegramAllowlist = telegramEnabled
    ? splitCsv((await rl.question(`Telegram allowlist user IDs (csv) [${(existing.channels.telegram.allowlist || []).join(",")}]: `)).trim() || (existing.channels.telegram.allowlist || []).join(","))
    : [];

  const discordEnabled = toBoolean((await rl.question(`Enable Discord? (y/n) [${existing.channels.discord.enabled ? "y" : "n"}]: `)).trim() || (existing.channels.discord.enabled ? "y" : "n"));
  const discordToken = discordEnabled
    ? ((await rl.question(`Discord bot token [${existing.channels.discord.botToken ? "***" : ""}]: `)).trim() || existing.channels.discord.botToken)
    : "";
  const discordAllowlist = discordEnabled
    ? splitCsv((await rl.question(`Discord allowlist user IDs (csv) [${(existing.channels.discord.allowlist || []).join(",")}]: `)).trim() || (existing.channels.discord.allowlist || []).join(","))
    : [];
  const discordChannels = discordEnabled
    ? splitCsv((await rl.question(`Discord allowed channel IDs for polling (csv) [${(existing.channels.discord.allowedChannels || []).join(",")}]: `)).trim() || (existing.channels.discord.allowedChannels || []).join(","))
    : [];

  const desktopSyncEnabled = toBoolean((await rl.question(`Enable desktop sync workaround? (y/n) [${existing.security.desktopSyncEnabled ? "y" : "n"}]: `)).trim() || (existing.security.desktopSyncEnabled ? "y" : "n"));

  rl.close();

  store.writeConfig({
    runtime: existing.runtime,
    defaults: {
      workingDir,
      approvalMode,
    },
    channels: {
      telegram: {
        enabled: telegramEnabled,
        botToken: telegramToken,
        allowlist: telegramAllowlist,
      },
      discord: {
        enabled: discordEnabled,
        botToken: discordToken,
        allowlist: discordAllowlist,
        allowedChannels: discordChannels,
      },
    },
    security: {
      desktopSyncEnabled,
    },
  });

  console.log(`Config written to ${store.configPath}`);
}

async function cmdStart() {
  const pid = readPid();
  if (isPidRunning(pid)) {
    console.log(`Daemon already running (pid=${pid})`);
    return;
  }

  const child = spawn(process.execPath, [path.resolve("./packages/ops-cli/src/cli.js"), "daemon-run"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, IM_CODEX_HOME: BASE_DIR },
  });

  child.unref();
  console.log("Daemon start requested");
}

async function cmdDaemonRun() {
  const app = new DaemonApp({ baseDir: BASE_DIR });
  const keepAlive = setInterval(() => {}, 45_000);

  fs.writeFileSync(PID_FILE, String(process.pid));
  writeStatus({ running: true, pid: process.pid, startedAt: new Date().toISOString() });

  const shutdown = async (reason) => {
    writeStatus({ running: false, pid: process.pid, stoppedAt: new Date().toISOString(), reason });
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      // ignore
    }
    try {
      await app.stop();
    } finally {
      clearInterval(keepAlive);
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", async (error) => {
    writeStatus({ running: false, pid: process.pid, crashedAt: new Date().toISOString(), reason: `uncaughtException: ${error.message}` });
    await app.stop();
    process.exit(1);
  });

  process.on("unhandledRejection", async (error) => {
    writeStatus({ running: false, pid: process.pid, crashedAt: new Date().toISOString(), reason: `unhandledRejection: ${String(error)}` });
    await app.stop();
    clearInterval(keepAlive);
    fs.rmSync(PID_FILE, { force: true });
    process.exit(1);
  });

  try {
    await app.start();
  } catch (error) {
    writeStatus({
      running: false,
      pid: process.pid,
      crashedAt: new Date().toISOString(),
      reason: `startup_failed: ${error.message}`,
    });
    fs.rmSync(PID_FILE, { force: true });
    await app.stop();
    clearInterval(keepAlive);
    process.exit(1);
  }
}

async function cmdStop() {
  const pid = readPid();
  if (!pid || !isPidRunning(pid)) {
    fs.rmSync(PID_FILE, { force: true });
    console.log("Daemon is not running");
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to daemon pid ${pid}`);
}

async function cmdStatus() {
  const status = readStatus();
  const pid = readPid();
  const running = Boolean(pid && isPidRunning(pid));
  if (!running && pid) {
    fs.rmSync(PID_FILE, { force: true });
  }

  console.log(JSON.stringify({
    ...status,
    pid: running ? pid : 0,
    running,
    baseDir: BASE_DIR,
  }, null, 2));
}

async function cmdLogs(args) {
  const lines = Number(args[0] || 80);
  const log = tailFile(path.join(store.logsDir, "daemon.log"), lines);
  if (!log) {
    console.log("No logs yet.");
    return;
  }
  console.log(log);
}

async function cmdDoctor() {
  const findings = runDoctor({ store });
  for (const finding of findings) {
    console.log(`[${finding.level}] ${finding.message}`);
  }
}

async function cmdBind(args) {
  const channel = args[0];
  const positionalChat = args[1] && !String(args[1]).startsWith("--") ? args[1] : null;
  const chatIdArg = positionalChat || getArgValue(args, "--chat", null);
  const userIdArg = getArgValue(args, "--user", null);
  const config = store.readConfig();
  const cwd = getArgValue(args, "--cwd", config.defaults.workingDir);

  if (!channel) {
    console.log("Usage: tool bind <channel> [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]");
    return;
  }

  const resolved = resolveBindTargets({
    channel,
    chatIdArg,
    userIdArg,
    config,
  });

  if (resolved.error) {
    console.log(resolved.error);
    console.log("Usage: tool bind <channel> [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]");
    return;
  }

  const channelAllowlist = config.channels?.[channel]?.allowlist || [];
  const binding = store.upsertBinding({
    channel,
    chatId: resolved.chatId,
    userId: resolved.userId,
    workingDir: cwd,
    policyProfile: {
      approvalMode: config.defaults.approvalMode,
      allowlist: channelAllowlist,
      autoApprove: false,
      desktopSyncEnabled: Boolean(config.security.desktopSyncEnabled),
    },
  });

  console.log(JSON.stringify(binding, null, 2));
}

async function cmdUnbind(args) {
  const channel = args[0];
  const chatId = args[1];
  if (!channel || !chatId) {
    console.log("Usage: tool unbind <channel> <chatId>");
    return;
  }
  store.removeBinding(channel, chatId);
  console.log(`Removed binding ${channel}:${chatId}`);
}

async function cmdThreads(args) {
  const action = args[0];
  const config = store.readConfig();
  const runtime = new AppServerRuntime({
    launchSpec: {
      command: config.runtime?.appServer?.command || "codex",
      args: config.runtime?.appServer?.args || ["app-server", "--listen", "stdio://"],
      description: "app-server",
      options: {},
    },
    reconnect: false,
  });

  try {
    if (action === "list") {
      const response = await runtime.listThreads({ limit: 50, archived: false });
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    if (action === "resume") {
      const threadId = args[1];
      const channel = getArgValue(args, "--channel", null);
      const chatId = getArgValue(args, "--chat", null);

      if (!threadId) {
        console.log("Usage: tool threads resume <threadId> [--channel <name> --chat <id>]");
        return;
      }

      await runtime.resumeThread(threadId);
      if (channel && chatId) {
        store.setBindingThread(channel, chatId, threadId);
      }
      console.log(`Resumed thread ${threadId}`);
      return;
    }

    console.log("Usage: tool threads <list|resume>");
  } finally {
    await runtime.stop();
  }
}

async function cmdPolicy(args) {
  const sub = args[0];
  if (sub !== "set") {
    console.log("Usage: tool policy set <channel> <chatId> [--approval <mode>] [--auto-approve <bool>] [--desktop-sync <bool>] [--allowlist <csv>]");
    return;
  }

  const channel = args[1];
  const chatId = args[2];
  const binding = store.getBinding(channel, chatId);
  if (!binding) {
    console.log(`Binding not found: ${channel}:${chatId}`);
    return;
  }

  const approvalMode = getArgValue(args, "--approval", binding.policyProfile.approvalMode);
  const autoApprove = toBoolean(getArgValue(args, "--auto-approve", String(binding.policyProfile.autoApprove)), binding.policyProfile.autoApprove);
  const desktopSyncEnabled = toBoolean(getArgValue(args, "--desktop-sync", String(binding.policyProfile.desktopSyncEnabled)), binding.policyProfile.desktopSyncEnabled);
  const allowlistRaw = getArgValue(args, "--allowlist", null);
  const allowlist = allowlistRaw == null ? binding.policyProfile.allowlist : splitCsv(allowlistRaw);

  const updated = store.upsertBinding({
    ...binding,
    policyProfile: {
      approvalMode,
      autoApprove,
      desktopSyncEnabled,
      allowlist,
    },
  });

  console.log(JSON.stringify(updated, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "setup":
      await cmdSetup();
      break;
    case "start":
      await cmdStart();
      break;
    case "daemon-run":
      await cmdDaemonRun();
      break;
    case "stop":
      await cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logs":
      await cmdLogs(args);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "bind":
      await cmdBind(args);
      break;
    case "unbind":
      await cmdUnbind(args);
      break;
    case "threads":
      await cmdThreads(args);
      break;
    case "resume": {
      const [threadId, channel, chatId] = args;
      if (!threadId || !channel || !chatId) {
        console.log("Usage: tool resume <threadId> <channel> <chatId>");
        break;
      }
      store.setBindingThread(channel, chatId, threadId);
      console.log(`Binding ${channel}:${chatId} now points to ${threadId}`);
      break;
    }
    case "policy":
      await cmdPolicy(args);
      break;
    default:
      console.log("Usage: tool <setup|start|stop|status|logs|doctor|bind|unbind|threads|resume|policy>");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
