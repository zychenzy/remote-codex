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
const DISCORD_API = "https://discord.com/api/v10";

const HELP_TOPICS = {
  setup: {
    summary: "Interactive configuration wizard for runtime and channel credentials.",
    usage: "reco setup",
    examples: [
      "reco setup",
    ],
  },
  start: {
    summary: "Start daemon in background.",
    usage: "reco start",
    examples: [
      "reco start",
    ],
  },
  stop: {
    summary: "Stop running daemon.",
    usage: "reco stop",
    examples: [
      "reco stop",
    ],
  },
  restart: {
    summary: "Restart daemon (stop if running, then start).",
    usage: "reco restart",
    examples: [
      "reco restart",
    ],
  },
  status: {
    summary: "Show daemon status, PID, and runtime baseDir.",
    usage: "reco status",
    examples: [
      "reco status",
    ],
  },
  logs: {
    summary: "Show recent daemon logs.",
    usage: "reco logs [lines] | reco logs chat [lines]",
    examples: [
      "reco logs",
      "reco logs 200",
      "reco logs chat",
      "reco logs chat 200",
    ],
  },
  doctor: {
    summary: "Run health checks (codex, config permissions, bindings, pending approvals).",
    usage: "reco doctor",
    examples: [
      "reco doctor",
    ],
  },
  bind: {
    summary: "Create or update channel binding to workspace/thread policy.",
    usage: "reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]",
    examples: [
      "reco bind discord",
      "reco bind discord 123456789012345678",
      "reco bind discord 123456789012345678 --user 99887766",
    ],
  },
  discord: {
    summary: "Discord diagnostics helpers (list channels, verify configured channel IDs).",
    usage: "reco discord <channels|verify>",
    examples: [
      "reco discord channels",
      "reco discord verify",
    ],
  },
  unbind: {
    summary: "Remove an existing channel binding.",
    usage: "reco unbind <channel> <chatId>",
    examples: [
      "reco unbind discord 123456789012345678",
    ],
  },
  threads: {
    summary: "Inspect and resume Codex threads through app-server.",
    usage: "reco threads <list|resume> [args]",
    examples: [
      "reco threads list",
      "reco threads resume <threadId> --channel discord --chat 123456789012345678",
    ],
  },
  resume: {
    summary: "Shortcut: attach an existing thread id to a binding.",
    usage: "reco resume <threadId> <channel> <chatId>",
    examples: [
      "reco resume 019cdd3b-cdee-7202-ba1b-b0c5713f9fb3 discord 123456789012345678",
    ],
  },
  policy: {
    summary: "Update binding policy options (approval, model profile, allowlist).",
    usage: "reco policy set <channel> <chatId> [--approval <mode>] [--auto-approve <bool>] [--allowlist <csv>] [--model <id>] [--effort <level>] [--mode <name>]",
    examples: [
      "reco policy set discord 123456789012345678 --approval on-request --auto-approve false",
      "reco policy set discord 123456789012345678 --model gpt-5.3-codex",
      "reco policy set discord 123456789012345678 --effort high --mode default",
    ],
  },
  help: {
    summary: "Show general or command-specific help.",
    usage: "reco help [command]",
    examples: [
      "reco help",
      "reco help bind",
    ],
  },
};

function printGeneralHelp() {
  const ordered = [
    "setup", "start", "stop", "restart", "status", "logs", "doctor",
    "bind", "discord", "unbind", "threads", "resume", "policy", "help",
  ];

  console.log("reco - IM-first Codex remote control CLI");
  console.log("");
  console.log("Usage:");
  console.log("  reco <command> [args]");
  console.log("");
  console.log("Commands:");
  for (const key of ordered) {
    console.log(`  ${key.padEnd(9)} ${HELP_TOPICS[key].summary}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  reco setup");
  console.log("  reco start");
  console.log("  reco bind discord");
  console.log("  reco discord channels");
  console.log("  reco policy set discord <chatId> --approval on-request");
  console.log("  reco help bind");
}

function printCommandHelp(command) {
  const topic = HELP_TOPICS[command];
  if (!topic) {
    console.log(`Unknown help topic: ${command}`);
    console.log("Run `reco help` to list commands.");
    return;
  }

  console.log(`reco ${command}`);
  console.log("");
  console.log(topic.summary);
  console.log("");
  console.log("Usage:");
  console.log(`  ${topic.usage}`);
  console.log("");
  console.log("Examples:");
  for (const example of topic.examples) {
    console.log(`  ${example}`);
  }
}

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

  rl.close();

  store.writeConfig({
    runtime: existing.runtime,
    defaults: {
      workingDir,
      approvalMode,
    },
    channels: {
      discord: {
        enabled: discordEnabled,
        botToken: discordToken,
        allowlist: discordAllowlist,
        allowedChannels: discordChannels,
      },
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

async function cmdRestart() {
  const existingPid = readPid();
  if (existingPid && isPidRunning(existingPid)) {
    process.kill(existingPid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon pid ${existingPid}`);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!isPidRunning(existingPid)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  await cmdStart();
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
  const chatMode = args[0] === "chat" || args[0] === "history";
  const linesArg = chatMode ? args[1] : args[0];
  const lines = Number.isFinite(Number(linesArg)) && Number(linesArg) > 0 ? Number(linesArg) : 80;
  const target = chatMode ? path.join(store.logsDir, "chat-history.jsonl") : path.join(store.logsDir, "daemon.log");
  const log = tailFile(target, lines);
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
    console.log("Usage: reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]");
    return;
  }

  if (channel !== "discord") {
    console.log(`Unsupported channel: ${channel}. Only discord is supported.`);
    console.log("Usage: reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]");
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
    console.log("Usage: reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]");
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
    },
  });

  if (channel === "discord" && chatIdArg) {
    const existingChannels = config.channels?.discord?.allowedChannels || [];
    if (!existingChannels.includes(resolved.chatId)) {
      const updatedConfig = {
        ...config,
        channels: {
          ...config.channels,
          discord: {
            ...config.channels.discord,
            allowedChannels: [resolved.chatId, ...existingChannels],
          },
        },
      };
      store.writeConfig(updatedConfig);
    }
  }

  console.log(JSON.stringify(binding, null, 2));
}

async function discordApi(token, path) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bot ${token}`,
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`discord ${path} failed: ${response.status} ${text}`);
  }
  return payload;
}

async function cmdDiscord(args) {
  const sub = args[0];
  const config = store.readConfig();
  const token = config.channels?.discord?.botToken || "";
  if (!token) {
    console.log("Discord bot token missing. Run `reco setup` first.");
    return;
  }

  if (sub === "channels") {
    const guilds = await discordApi(token, "/users/@me/guilds?limit=200");
    const rows = [];
    for (const guild of guilds) {
      const channels = await discordApi(token, `/guilds/${guild.id}/channels`);
      for (const ch of channels) {
        if (![0, 5].includes(ch.type)) {
          continue;
        }
        rows.push({
          guildId: String(guild.id),
          guildName: guild.name,
          channelId: String(ch.id),
          channelName: ch.name || "(unnamed)",
          type: ch.type === 0 ? "GUILD_TEXT" : "GUILD_ANNOUNCEMENT",
        });
      }
    }
    console.log(JSON.stringify({ channels: rows }, null, 2));
    return;
  }

  if (sub === "verify") {
    const ids = config.channels?.discord?.allowedChannels || [];
    if (ids.length === 0) {
      console.log("No Discord allowedChannels configured.");
      return;
    }

    const checks = [];
    for (const id of ids) {
      try {
        const ch = await discordApi(token, `/channels/${id}`);
        checks.push({
          channelId: String(id),
          ok: true,
          name: ch?.name || null,
          guildId: ch?.guild_id || null,
        });
      } catch (error) {
        checks.push({
          channelId: String(id),
          ok: false,
          error: error.message,
        });
      }
    }
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  console.log("Usage: reco discord <channels|verify>");
}

async function cmdUnbind(args) {
  const channel = args[0];
  const chatId = args[1];
  if (!channel || !chatId) {
    console.log("Usage: reco unbind <channel> <chatId>");
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
        console.log("Usage: reco threads resume <threadId> [--channel <name> --chat <id>]");
        return;
      }

      await runtime.resumeThread(threadId);
      if (channel && chatId) {
        store.setBindingThread(channel, chatId, threadId);
      }
      console.log(`Resumed thread ${threadId}`);
      return;
    }

    console.log("Usage: reco threads <list|resume>");
  } finally {
    await runtime.stop();
  }
}

async function cmdPolicy(args) {
  const sub = args[0];
  if (sub !== "set") {
    console.log("Usage: reco policy set <channel> <chatId> [--approval <mode>] [--auto-approve <bool>] [--allowlist <csv>] [--model <id>] [--effort <level>] [--mode <name>]");
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
  const allowlistRaw = getArgValue(args, "--allowlist", null);
  const allowlist = allowlistRaw == null ? binding.policyProfile.allowlist : splitCsv(allowlistRaw);
  const modelRaw = getArgValue(args, "--model", null);
  const model = modelRaw == null ? (binding.policyProfile.model ?? null) : (String(modelRaw).trim() || null);
  const effortRaw = getArgValue(args, "--effort", null);
  const normalizedEffortRaw = effortRaw == null ? null : String(effortRaw).trim().toLowerCase();
  const reasoningEffort = effortRaw == null
    ? (binding.policyProfile.reasoningEffort ?? null)
    : (["default", "auto"].includes(normalizedEffortRaw) ? null : (String(effortRaw).trim() || null));
  const modeRaw = getArgValue(args, "--mode", null);
  const normalizedModeRaw = modeRaw == null ? null : String(modeRaw).trim().toLowerCase();
  const collaborationMode = modeRaw == null
    ? (binding.policyProfile.collaborationMode ?? null)
    : (["default", "auto"].includes(normalizedModeRaw) ? "default" : (String(modeRaw).trim() || null));

  const updated = store.upsertBinding({
    ...binding,
    policyProfile: {
      ...binding.policyProfile,
      approvalMode,
      autoApprove,
      allowlist,
      model,
      reasoningEffort,
      collaborationMode,
    },
  });

  console.log(JSON.stringify(updated, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const normalized = command || "help";

  if (normalized === "--help" || normalized === "-h") {
    printGeneralHelp();
    return;
  }

  switch (normalized) {
    case "help":
      if (args[0]) {
        printCommandHelp(args[0]);
      } else {
        printGeneralHelp();
      }
      break;
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
    case "restart":
      await cmdRestart();
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
    case "discord":
      await cmdDiscord(args);
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
        console.log("Usage: reco resume <threadId> <channel> <chatId>");
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
      console.log(`Unknown command: ${normalized}`);
      console.log("");
      printGeneralHelp();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
