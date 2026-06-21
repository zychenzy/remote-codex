import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { AppServerRuntime } from "../../core-runtime/src/index.js";
import {
  DiscordAdapter,
  parseIncomingCommand,
} from "../../im-gateway/src/index.js";
import { StateStore } from "../../state-store/src/index.js";
import { ApprovalBroker } from "./approval-broker.js";
import { commandManual } from "./help-manual.js";
import { createLogger } from "./logger.js";
import { handleModelAndSkillsCommand } from "./model-skills-handler.js";
import { reconcileRuntimeState } from "./runtime-state-reconciler.js";
import { formatAutopilotAction, formatAutopilotPause, formatAutopilotStatus } from "./autopilot-format.js";
import { AutopilotSupervisor } from "./autopilot-supervisor.js";
import {
  normalizeToolProgressMode,
  summarizePlanUpdate,
  summarizeToolActivity,
} from "./discord-turn-ux.js";
import { allAgentTextFromTurn, allUserTextFromTurn } from "./turn-text-utils.js";
import { startTurnWithRecovery } from "./turn-recovery.js";
import { detectDelta, detectThreadId, detectTurnId } from "./utils.js";

function bindingKey(channel, chatId) {
  return `${channel}:${chatId}`;
}

function inboundDedupeKey(context = {}) {
  const channel = String(context.channel || "").trim();
  const chatId = String(context.chatId || "").trim();
  const interactionId = String(context.discordMeta?.interactionId || "").trim();
  if (channel && chatId && interactionId) {
    return `inbound:${channel}:${chatId}:interaction:${interactionId}`;
  }

  const messageId = String(context.messageId || "").trim();
  if (channel && chatId && messageId) {
    return `inbound:${channel}:${chatId}:message:${messageId}`;
  }

  return "";
}

const CONTROL_COMMAND_DEDUPE_TTL_MS = 5_000;

function threadIdFromResponse(response) {
  return response?.thread?.id || response?.threadId || response?.thread_id || null;
}

function turnIdFromResponse(response) {
  return response?.turn?.id || response?.turnId || response?.turn_id || null;
}

function supportedApprovalMethod(method) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput"
  );
}

function threadScopedAutoApproveSupportedMethod(method) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  );
}

function requestUserInputQuestions(params = {}) {
  const candidates = [
    params?.questions,
    params?.input?.questions,
    params?.request?.questions,
    params?.payload?.questions,
  ];
  for (const value of candidates) {
    if (!Array.isArray(value)) {
      continue;
    }
    const out = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = String(entry.id || "").trim();
      const question = String(entry.question || entry.prompt || entry.text || "").trim();
      const optionsRaw = Array.isArray(entry.options) ? entry.options : [];
      const options = optionsRaw
        .map((option) => {
          if (typeof option === "string") {
            return option.trim();
          }
          if (option && typeof option === "object") {
            return String(option.label || option.value || option.id || "").trim();
          }
          return "";
        })
        .filter(Boolean);
      out.push({ id, question, options });
    }
    if (out.length) {
      return out;
    }
  }
  return [];
}

function questionKey(question, index) {
  return String(question?.id || "").trim() || `q${index + 1}`;
}

function sanitizeAnswerValue(value) {
  return String(value || "").replace(/[;\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeToolAnswerPayload(rawPayload, questions = []) {
  const payload = String(rawPayload || "").trim();
  if (!payload) {
    return { payload: "", error: "" };
  }

  const normalized = payload.toLowerCase();
  if (["rec", "recommended", "default"].includes(normalized)) {
    const pairs = [];
    for (let i = 0; i < questions.length; i += 1) {
      const first = sanitizeAnswerValue(questions[i]?.options?.[0] || "");
      if (!first) {
        continue;
      }
      pairs.push(`${questionKey(questions[i], i)}=${first}`);
    }
    if (!pairs.length) {
      return { payload: "", error: "No selectable options found for this prompt." };
    }
    return { payload: pairs.join(";"), error: "" };
  }

  if (!payload.includes("=") && questions.length) {
    const tokens = payload.split(/[\s,]+/).filter(Boolean);
    const numeric = tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token));
    if (numeric) {
      if (tokens.length > questions.length) {
        return {
          payload: "",
          error: `Too many selections: got ${tokens.length}, but only ${questions.length} question(s) are available.`,
        };
      }
      const pairs = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const question = questions[i];
        if (!question) {
          break;
        }
        const optionIndex = Number(tokens[i]) - 1;
        const selected = sanitizeAnswerValue(question.options?.[optionIndex] || "");
        if (!selected) {
          return {
            payload: "",
            error: `Invalid option index for Q${i + 1}: ${tokens[i]}.`,
          };
        }
        pairs.push(`${questionKey(question, i)}=${selected}`);
      }
      if (!pairs.length) {
        return { payload: "", error: "No valid selections provided." };
      }
      return { payload: pairs.join(";"), error: "" };
    }
  }

  return { payload, error: "" };
}

function makeLaunchSpec(config) {
  if (config?.runtime?.appServer?.command) {
    return {
      command: config.runtime.appServer.command,
      args: config.runtime.appServer.args || [],
      description: `${config.runtime.appServer.command} ${(config.runtime.appServer.args || []).join(" ")}`,
      options: {},
    };
  }

  return null;
}

function resolveWorkspacePath(inputPath, currentWorkingDir) {
  const trimmed = String(inputPath || "").trim();
  if (!trimmed) {
    return { value: currentWorkingDir, input: "", resolved: currentWorkingDir };
  }

  let candidate = trimmed;
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.resolve(os.homedir(), candidate.slice(2));
  } else if (candidate.startsWith("~")) {
    candidate = path.join(os.homedir(), candidate.slice(1).replace(/^[/\\]+/, ""));
  } else if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(currentWorkingDir, candidate);
  }

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return {
        error: `Not a directory: ${trimmed} (resolved: ${candidate})`,
        input: trimmed,
        resolved: candidate,
      };
    }
  } catch {
    return {
      error: `Directory does not exist: ${trimmed} (resolved: ${candidate})`,
      input: trimmed,
      resolved: candidate,
    };
  }

  return { value: candidate, input: trimmed, resolved: candidate };
}

function isThreadNotFoundError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found");
}

function threadListFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }

  const candidates = [
    response?.threads,
    response?.items,
    response?.data?.threads,
    response?.data?.items,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function singleLine(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function threadDisplayTitle(thread) {
  const raw = thread?.name || thread?.title || thread?.preview || "";
  const text = singleLine(raw);
  if (!text) {
    return "(no title)";
  }
  if (text.length <= 96) {
    return text;
  }
  return `${text.slice(0, 93)}...`;
}

function extractThreadId(thread) {
  return String(thread?.id || thread?.threadId || thread?.thread_id || "");
}

function extractThreadCwd(thread) {
  const cwd = singleLine(thread?.cwd || "");
  return cwd || "";
}

function parseArgsAndOptions(args = []) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next == null || String(next).startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = String(next);
    i += 1;
  }
  return { positional, options };
}

function toBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toInt(value, fallback = 10, min = 1, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

function formatUnixReset(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) {
    return "unknown";
  }
  const date = new Date(n * 1000);
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatReset(window = {}) {
  const time = formatUnixReset(window?.resetsAt);
  const n = Number(window?.resetsAt);
  const minutes = Number(window?.windowDurationMins);
  if (!Number.isFinite(n) || !Number.isFinite(minutes) || minutes < 24 * 60) {
    return time;
  }
  const date = new Date(n * 1000);
  const monthDay = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date).replace(",", "");
  return `${time} on ${monthDay}`;
}

function quotaLabel(window = {}, fallback = "Limit") {
  const minutes = Number(window?.windowDurationMins);
  if (minutes === 300) {
    return "5h limit";
  }
  if (minutes === 10080) {
    return "Weekly limit";
  }
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 1440 === 0) {
      return `${minutes / 1440}d limit`;
    }
    if (minutes % 60 === 0) {
      return `${minutes / 60}h limit`;
    }
    return `${minutes}m limit`;
  }
  return fallback;
}

function usageBar(percentLeft, width = 20) {
  if (!Number.isFinite(percentLeft)) {
    return `[${"?".repeat(width)}]`;
  }
  const filled = Math.min(Math.max(Math.round((percentLeft / 100) * width), 0), width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatUsageWindow(label, window = {}) {
  const labelText = String(label || "").replace(/:\s*$/, "");
  const used = Number(window?.usedPercent);
  if (!Number.isFinite(used)) {
    return `${labelText.padEnd(14)} ${usageBar(null)} usage unknown`;
  }
  const left = Math.min(Math.max(100 - used, 0), 100);
  const roundedLeft = Math.round(left);
  const leftText = `${roundedLeft}% left`.padEnd(8);
  return `${labelText.padEnd(14)} ${usageBar(left)} ${leftText} resets ${formatReset(window)}`;
}

function rateLimitEntriesFromResponse(response = {}) {
  if (response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
    return Object.values(response.rateLimitsByLimitId).filter(Boolean);
  }
  return response?.rateLimits ? [response.rateLimits] : [];
}

function formatRateLimits(response = {}) {
  const entries = rateLimitEntriesFromResponse(response);
  if (!entries.length) {
    return "No ChatGPT usage data returned by app-server.";
  }
  const windows = [];
  const notices = [];
  for (const entry of entries) {
    if (entry.primary) {
      windows.push({ label: quotaLabel(entry.primary, "Primary limit"), window: entry.primary });
    }
    if (entry.secondary) {
      windows.push({ label: quotaLabel(entry.secondary, "Secondary limit"), window: entry.secondary });
    }
    if (entry.rateLimitReachedType) {
      notices.push(`Limit state: ${entry.rateLimitReachedType}`);
    }
  }
  const lines = windows.map(({ label, window }) => formatUsageWindow(label, window));
  for (const notice of notices) {
    lines.push(notice);
  }
  if (!lines.length) {
    return "No ChatGPT usage windows returned by app-server.";
  }
  return ["```", ...lines, "```"].join("\n");
}

function formatConfigRequirements(response = {}) {
  const requirements = response?.requirements;
  if (!requirements) {
    return "No app-server policy requirements are configured.";
  }
  const lines = ["App-server requirements:"];
  if (Array.isArray(requirements.allowedApprovalPolicies)) {
    lines.push(`Approval policies: ${requirements.allowedApprovalPolicies.join(", ") || "none"}`);
  }
  if (Array.isArray(requirements.allowedSandboxModes)) {
    lines.push(`Sandbox modes: ${requirements.allowedSandboxModes.join(", ") || "none"}`);
  }
  if (requirements.network && typeof requirements.network === "object") {
    const network = requirements.network;
    lines.push(`Network: ${network.enabled ? "enabled" : "restricted"}`);
    if (Array.isArray(network.allowedDomains) && network.allowedDomains.length) {
      lines.push(`Allowed domains: ${network.allowedDomains.join(", ")}`);
    }
  }
  const features = requirements.featureRequirements;
  if (features && typeof features === "object") {
    const entries = Object.entries(features).map(([key, value]) => `${key}=${value}`);
    if (entries.length) {
      lines.push(`Features: ${entries.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function goalFromResponse(response = {}) {
  if (typeof response?.goal === "string") {
    return response.goal;
  }
  if (response?.goal && typeof response.goal === "object") {
    return response.goal.text || response.goal.description || JSON.stringify(response.goal);
  }
  if (typeof response?.thread?.goal === "string") {
    return response.thread.goal;
  }
  if (response?.thread?.goal && typeof response.thread.goal === "object") {
    return response.thread.goal.text || response.thread.goal.description || JSON.stringify(response.thread.goal);
  }
  return "";
}

function nextCursorFromResponse(response) {
  return response?.nextCursor || response?.next_cursor || response?.cursor || null;
}

function modelListFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.models)) {
    return response.models;
  }
  return [];
}

function collaborationModesFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.modes)) {
    return response.modes;
  }
  return [];
}

function skillsEntriesFromResponse(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  return [];
}

function buildDiscordThreadListNativeUi({ threads = [], nextCursor = null } = {}) {
  return {
    kind: "threadList",
    title: "Threads",
    description: "Choose a thread to resume. Use typed commands for read/archive/fork controls.",
    components: {
      selects: threads.length ? [{
        placeholder: "Resume a thread",
        options: threads.slice(0, 25).map((thread, index) => ({
          label: `${index + 1}. ${thread.title || "Untitled"}`.slice(0, 100),
          description: `${thread.cwd || "unknown"}${thread.current ? " | current" : ""}`.slice(0, 100),
          commandText: `/resume ${thread.threadId}`,
        })),
      }] : [],
      buttons: [
        ...(nextCursor ? [{ label: "Next Page", style: 1, commandText: "/thread more" }] : []),
      ],
    },
  };
}

function buildDiscordModelPickerNativeUi({
  currentModel = "",
  currentEffort = "",
  currentMode = "",
  models = [],
  modes = [],
} = {}) {
  const modelById = new Map();
  for (const item of Array.isArray(models) ? models : []) {
    const id = String(item?.model || item?.id || "").trim();
    if (!id || modelById.has(id)) {
      continue;
    }
    const efforts = (item?.supportedReasoningEfforts || [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
      .filter(Boolean)
      .join(",");
    modelById.set(id, {
      id,
      description: `${item?.isDefault ? "default | " : ""}${efforts ? `efforts:${efforts}` : "model"}`.slice(0, 100),
    });
    if (modelById.size >= 25) {
      break;
    }
  }
  const normalizedModels = Array.from(modelById.values());
  const modeByKey = new Map();
  for (const item of Array.isArray(modes) ? modes : []) {
    const mode = String(item?.mode || item?.name || "").trim();
    if (!mode) {
      continue;
    }
    const key = mode.toLowerCase();
    if (key === "default" || modeByKey.has(key)) {
      continue;
    }
    modeByKey.set(key, mode);
    if (modeByKey.size >= 24) {
      break;
    }
  }
  const normalizedModes = Array.from(modeByKey.values());
  const currentModeKey = String(currentMode || "").trim().toLowerCase();

  return {
    kind: "modelPicker",
    title: "Model Controls",
    description: [
      `Current model: ${currentModel || "runtime default"}`,
      `Current effort: ${currentEffort || "runtime default"}`,
      `Current mode: ${currentMode || "runtime default"}`,
    ].join("\n"),
    components: {
      selects: [
        ...(normalizedModels.length ? [{
          placeholder: "Set model",
          options: normalizedModels.map((item) => ({
            label: item.id,
            description: item.description,
            commandText: `/model set ${item.id}`,
            defaultValue: item.id === currentModel,
          })),
        }] : []),
        {
          placeholder: "Set reasoning effort",
          options: [
            { label: "runtime default", description: "Reset sticky effort", commandText: "/model effort set default", defaultValue: !currentEffort },
            { label: "low", description: "Low reasoning effort", commandText: "/model effort set low", defaultValue: currentEffort === "low" },
            { label: "medium", description: "Medium reasoning effort", commandText: "/model effort set medium", defaultValue: currentEffort === "medium" },
            { label: "high", description: "High reasoning effort", commandText: "/model effort set high", defaultValue: currentEffort === "high" },
            { label: "xhigh", description: "Extra high reasoning effort", commandText: "/model effort set xhigh", defaultValue: currentEffort === "xhigh" },
          ],
        },
        {
          placeholder: "Set collaboration mode",
          options: [
            { label: "default", description: "Use runtime default mode", commandText: "/model mode set default", defaultValue: !currentModeKey || currentModeKey === "default" },
            ...normalizedModes.map((mode) => ({
              label: mode,
              description: "Available collaboration mode",
              commandText: `/model mode set ${mode}`,
              defaultValue: currentModeKey === mode.toLowerCase(),
            })),
          ].slice(0, 25),
        },
      ],
      buttons: [
        { label: "Show Profile", style: 2, commandText: "/model show" },
        { label: "Refresh Models", style: 2, commandText: "/model" },
      ],
    },
  };
}

function listWorkspaceSubdirectories(currentDir) {
  const normalized = String(currentDir || "").trim();
  if (!normalized) {
    return {
      error: "Workspace is not set for this binding.",
      currentDir: "",
      directories: [],
    };
  }

  try {
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return {
        error: `Workspace is not a directory: ${normalized}`,
        currentDir: normalized,
        directories: [],
      };
    }
  } catch {
    return {
      error: `Workspace directory does not exist: ${normalized}`,
      currentDir: normalized,
      directories: [],
    };
  }

  const directories = [];
  for (const entry of fs.readdirSync(normalized, { withFileTypes: true })) {
    const fullPath = path.join(normalized, entry.name);
    if (entry.isDirectory()) {
      directories.push(fullPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          directories.push(fullPath);
        }
      } catch {
        // Ignore broken links while listing candidates.
      }
    }
  }

  directories.sort((left, right) => hiddenNameLastCompare(path.basename(left), path.basename(right)));
  return {
    currentDir: normalized,
    directories: directories.map((dirPath) => ({
      path: dirPath,
      label: path.basename(dirPath) || dirPath,
    })),
  };
}

function buildDiscordCwdBrowserNativeUi({ currentDir = "", directories = [] } = {}) {
  const options = directories.slice(0, 25).map((entry) => ({
    label: String(entry?.label || "").slice(0, 100),
    description: String(entry?.path || "").slice(0, 100),
    path: String(entry?.path || ""),
  }));
  const hasMore = directories.length > options.length;
  return {
    kind: "cwdBrowser",
    title: "Browse Workspace",
    description: [
      `Current workspace: ${currentDir || "unknown"}`,
      options.length
        ? "Choose a subdirectory, then confirm to jump there."
        : "No subdirectories found in the current workspace.",
      hasMore ? `Showing first ${options.length} of ${directories.length} subdirectories.` : "",
    ].filter(Boolean).join("\n"),
    currentDir,
    components: {
      selects: options.length ? [{
        placeholder: "Select a subdirectory",
        options,
      }] : [],
      buttons: [
        { label: "Confirm", style: 3, action: "confirm", disabled: options.length === 0 },
        { label: "Cancel", style: 4, action: "cancel" },
      ],
    },
  };
}

function parseCwdBrowseTarget(rawPath = "") {
  const trimmed = String(rawPath || "").trim();
  const match = /^browse(?:\s+(.*))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  return String(match[1] || "").trim();
}

function parseCwdNewTarget(rawPath = "") {
  const trimmed = String(rawPath || "").trim();
  const match = /^new(?:\s+(.*))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  return String(match[1] || "").trim();
}

function hiddenNameLastCompare(leftName, rightName) {
  const left = String(leftName || "");
  const right = String(rightName || "");
  const leftHidden = left.startsWith(".");
  const rightHidden = right.startsWith(".");
  if (leftHidden !== rightHidden) {
    return leftHidden ? 1 : -1;
  }
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function decodeCommandValue(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  try {
    return Buffer.from(normalized, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function isPathInsideRoot(candidatePath, rootPath) {
  const candidate = path.resolve(String(candidatePath || "").trim());
  const root = path.resolve(String(rootPath || "").trim());
  if (!candidate || !root) {
    return false;
  }
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function validateDirectoryWithinRoot(rootDir, targetDir) {
  const root = path.resolve(String(rootDir || "").trim());
  const candidate = path.resolve(String(targetDir || "").trim());
  if (!root || !candidate) {
    return { error: "Workspace directory is not set." };
  }
  if (!isPathInsideRoot(candidate, root)) {
    return { error: `Directory is outside workspace root: ${candidate}` };
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return { error: `Not a directory: ${candidate}` };
    }
  } catch {
    return { error: `Directory does not exist: ${candidate}` };
  }
  return { rootDir: root, currentDir: candidate };
}

function listWorkspaceEntries(rootDir, currentDir) {
  const validated = validateDirectoryWithinRoot(rootDir, currentDir);
  if (validated.error) {
    return { error: validated.error, rootDir, currentDir, entries: [] };
  }

  const entries = [];
  for (const entry of fs.readdirSync(validated.currentDir, { withFileTypes: true })) {
    const fullPath = path.join(validated.currentDir, entry.name);
    if (entry.isDirectory()) {
      entries.push({
        path: fullPath,
        entryType: "dir",
        label: `${entry.name}/`,
        description: `dir | ${path.relative(validated.rootDir, fullPath) || entry.name}`.slice(0, 100),
      });
      continue;
    }
    if (entry.isFile()) {
      entries.push({
        path: fullPath,
        entryType: "file",
        label: entry.name,
        description: `file | ${path.relative(validated.rootDir, fullPath) || entry.name}`.slice(0, 100),
      });
    }
  }

  entries.sort((left, right) => {
    if (left.entryType !== right.entryType) {
      return left.entryType === "dir" ? -1 : 1;
    }
    return hiddenNameLastCompare(left.label, right.label);
  });

  return {
    rootDir: validated.rootDir,
    currentDir: validated.currentDir,
    entries,
    canGoUp: validated.currentDir !== validated.rootDir,
  };
}

function buildDiscordFilePickerNativeUi({
  mode = "browser",
  rootDir = "",
  currentDir = "",
  query = "",
  entries = [],
  canGoUp = false,
} = {}) {
  const limitedEntries = entries.slice(0, 25).map((entry) => ({
    path: String(entry?.path || ""),
    entryType: String(entry?.entryType || "file"),
    label: String(entry?.label || "").slice(0, 100),
    description: String(entry?.description || "").slice(0, 100),
  }));
  const hasMore = entries.length > limitedEntries.length;
  const searching = mode === "search";
  return {
    kind: "filePicker",
    mode,
    title: searching ? "Search Files" : "Browse Files",
    description: [
      `Workspace root: ${rootDir || "unknown"}`,
      searching ? `Query: ${query || "(empty)"}` : `Current directory: ${currentDir || "unknown"}`,
      limitedEntries.length
        ? (searching ? "Choose a file, then preview it." : "Select a directory to enter it, or select a file to preview.")
        : (searching ? "No matching files found." : "This directory is empty."),
      hasMore ? `Showing first ${limitedEntries.length} of ${entries.length} entries.` : "",
    ].filter(Boolean).join("\n"),
    rootDir,
    currentDir,
    parentDir: canGoUp ? path.dirname(currentDir) : rootDir,
    query,
    canGoUp,
    components: {
      selects: limitedEntries.length ? [{
        placeholder: searching ? "Select a file result" : "Select a directory or file",
        options: limitedEntries,
      }] : [],
    },
  };
}

function formatFileListText({ mode = "browser", currentDir = "", query = "", entries = [] } = {}) {
  const heading = mode === "search"
    ? `Search results for "${query}" (${entries.length})`
    : `Files in ${currentDir}`;
  const lines = entries.slice(0, 25).map((entry, index) => {
    const marker = entry.entryType === "dir" ? "[D]" : "[F]";
    return `${index + 1}. ${marker} ${entry.label}`;
  });
  return [heading, ...lines].join("\n");
}

function searchWorkspaceFiles(rootDir, query, { limit = 100 } = {}) {
  const root = path.resolve(String(rootDir || "").trim());
  const needle = String(query || "").trim().toLowerCase();
  if (!root || !needle) {
    return [];
  }

  const results = [];
  const stack = [root];
  while (stack.length && results.length < limit) {
    const currentDir = stack.pop();
    let dirents = [];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((left, right) => hiddenNameLastCompare(left.name, right.name));
    for (const entry of dirents) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(root, fullPath) || entry.name;
      if (!relativePath.toLowerCase().includes(needle)) {
        continue;
      }
      results.push({
        path: fullPath,
        entryType: "file",
        label: entry.name,
        description: relativePath.slice(0, 100),
      });
      if (results.length >= limit) {
        break;
      }
    }
  }

  results.sort((left, right) => left.description.localeCompare(right.description, undefined, { sensitivity: "base" }));
  return results;
}

function looksBinary(buffer) {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function fenceInfoForFile(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").trim().toLowerCase();
  return /^[a-z0-9_+-]{1,20}$/.test(ext) ? ext : "txt";
}

function escapeFenceContent(text = "") {
  return String(text || "").replace(/```/g, "``\\`");
}

function buildFilePreview(filePath, rootDir) {
  const resolvedFile = path.resolve(String(filePath || "").trim());
  const resolvedRoot = path.resolve(String(rootDir || "").trim());
  if (!resolvedFile || !resolvedRoot) {
    return { error: "Preview target is missing." };
  }
  if (!isPathInsideRoot(resolvedFile, resolvedRoot)) {
    return { error: `Preview target is outside workspace root: ${resolvedFile}` };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    return { error: `File does not exist: ${resolvedFile}` };
  }
  if (!stat.isFile()) {
    return { error: `Not a file: ${resolvedFile}` };
  }

  const previewBytes = Math.min(stat.size, 8192);
  const buffer = Buffer.alloc(previewBytes);
  const fd = fs.openSync(resolvedFile, "r");
  try {
    fs.readSync(fd, buffer, 0, previewBytes, 0);
  } finally {
    fs.closeSync(fd);
  }

  const relativePath = path.relative(resolvedRoot, resolvedFile) || path.basename(resolvedFile);
  if (looksBinary(buffer)) {
    return {
      text: [
        `Preview unavailable for binary file: ${relativePath}`,
        `Path: ${resolvedFile}`,
        `Size: ${stat.size} bytes`,
      ].join("\n"),
    };
  }

  const previewText = escapeFenceContent(buffer.toString("utf8").replace(/\r/g, ""));
  const truncated = stat.size > previewBytes;
  return {
    text: [
      `Preview: ${relativePath}`,
      `Path: ${resolvedFile}`,
      truncated ? `Showing first ${previewBytes} bytes of ${stat.size}.` : `Size: ${stat.size} bytes`,
      `\`\`\`${fenceInfoForFile(resolvedFile)}`,
      previewText,
      "```",
    ].join("\n"),
  };
}

function formatRuntimeError(error) {
  const message = String(error?.message || "unknown error");
  const lower = message.toLowerCase();
  if (lower.includes("not initialized")) {
    return "Runtime is not initialized yet. Retry in a moment or run `reco restart`.";
  }
  if (lower.includes("thread not found")) {
    return "Thread not found. Use `/thread list` or start a new one with `/new`.";
  }
  if (lower.includes("method not found")) {
    return "This command is not supported by your current codex app-server version.";
  }
  if (lower.includes("requires experimentalapi capability")) {
    return "This command requires experimental API support from codex app-server. Check your runtime version.";
  }
  if (lower.includes("operation not permitted")) {
    return "Operation not permitted by runtime or file permissions.";
  }
  if (lower.includes("server overloaded")) {
    return "Runtime is overloaded. Retry shortly.";
  }
  return `Runtime error: ${message}`;
}

function riskyThreadActionRequiresConfirm(approvalMode) {
  return approvalMode !== "never";
}

function autopilotConfigForBinding(binding) {
  return binding?.policyProfile?.autopilot || {};
}

function extractSkillNameFromPrompt(prompt = "") {
  const match = String(prompt || "").match(/\$([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function splitTextIntoChunks(text, maxLen = 1600) {
  const input = String(text || "").replace(/\r/g, "");
  if (!input) {
    return [];
  }
  if (input.length <= maxLen) {
    return [input];
  }

  const lines = input.split("\n");
  const chunks = [];
  let current = "";
  let inFence = false;
  let fenceHeader = "```";

  const pushCurrent = () => {
    const out = current.trimEnd();
    if (out) {
      chunks.push(out);
    }
    current = "";
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const lineWithNl = `${line}\n`;
    const trimmed = line.trim();
    const isFenceLine = trimmed.startsWith("```");

    if (current.length > 0 && current.length + lineWithNl.length > maxLen) {
      if (inFence) {
        current += "```\n";
        pushCurrent();
        current = `${fenceHeader}\n`;
      } else {
        pushCurrent();
      }
    }

    current += lineWithNl;

    if (isFenceLine) {
      if (!inFence) {
        inFence = true;
        fenceHeader = trimmed || "```";
      } else {
        inFence = false;
        fenceHeader = "```";
      }
    }
  }

  if (current.trim()) {
    if (inFence) {
      current += "\n```";
    }
    pushCurrent();
  }
  return chunks;
}

function clipText(text, maxLen = 400) {
  const input = String(text || "");
  if (!maxLen || input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, maxLen - 3)}...`;
}

function quoteMarkdown(text) {
  return String(text || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0]?.trim() || "";
}

function turnOutputKey(threadId, turnId) {
  const tid = String(turnId || "").trim();
  if (tid) {
    return `turn:${tid}`;
  }
  const thid = String(threadId || "").trim();
  if (thid) {
    return `thread:${thid}`;
  }
  return "";
}

function boundaryScan(text, { minChunkChars = 280, after = 0 } = {}) {
  const input = String(text || "").replace(/\r/g, "");
  if (!input) {
    return {
      hardBoundary: 0,
      softBoundary: 0,
      inFence: false,
    };
  }

  let inFence = false;
  let lineStart = 0;
  let lastHardBoundary = 0;
  let lastSafeNewline = 0;

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== "\n") {
      continue;
    }
    const line = input.slice(lineStart, i);
    const trimmed = line.trim();
    const isFenceLine = trimmed.startsWith("```");

    if (isFenceLine) {
      inFence = !inFence;
      if (!inFence) {
        lastHardBoundary = i + 1;
      }
    } else if (!inFence) {
      lastSafeNewline = i + 1;
      if (!trimmed) {
        lastHardBoundary = i + 1;
      }
    }

    lineStart = i + 1;
  }

  if (!inFence && input.length - lastHardBoundary >= minChunkChars && lastSafeNewline > lastHardBoundary) {
    lastHardBoundary = lastSafeNewline;
  }

  let softBoundary = 0;
  if (!inFence) {
    const pendingChars = input.length - after;
    if (pendingChars >= minChunkChars) {
      if (lastSafeNewline > after) {
        softBoundary = lastSafeNewline;
      } else {
        const target = Math.min(input.length, after + minChunkChars + 160);
        let whitespace = input.lastIndexOf(" ", target);
        if (whitespace <= after) {
          whitespace = input.lastIndexOf("\t", target);
        }
        softBoundary = whitespace > after ? whitespace : Math.min(input.length, after + minChunkChars);
      }
    }
  }

  return {
    hardBoundary: Math.min(Math.max(lastHardBoundary, 0), input.length),
    softBoundary: Math.min(Math.max(softBoundary, 0), input.length),
    inFence,
  };
}

function normalizeTurnStatus(status) {
  if (typeof status === "string" && status.trim()) {
    return status;
  }
  if (status && typeof status === "object" && typeof status.type === "string" && status.type.trim()) {
    return status.type;
  }
  return "completed";
}

function normalizeChangeKind(kind) {
  return String(kind || "").trim().toLowerCase();
}

function isWholeFileChange(kind) {
  const normalized = normalizeChangeKind(kind);
  return ["added", "deleted", "removed"].includes(normalized);
}

function wholeFilePlaceholderDiff(kind, filePath) {
  const normalized = normalizeChangeKind(kind);
  const safePath = String(filePath || "").trim();
  if (normalized === "added") {
    const rhs = safePath ? `b/${safePath}` : "/dev/null";
    return [
      `+++ ${rhs}`,
      "+ [full file content omitted]",
    ].join("\n");
  }
  const lhs = safePath ? `a/${safePath}` : "/dev/null";
  return [
    `--- ${lhs}`,
    "- [full file content omitted]",
  ].join("\n");
}

function formatDiffBlock(header, diffText) {
  return [
    header,
    "```diff",
    String(diffText || "").trim(),
    "```",
  ].join("\n");
}

function fileChangeDiffText(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const blocks = [];
  for (const change of changes) {
    const kind = normalizeChangeKind(change?.kind);
    const filePath = String(change?.path || "").trim();
    const header = filePath
      ? `Path: ${filePath}${kind ? ` (${kind})` : ""}`
      : `Path: (unknown)${kind ? ` (${kind})` : ""}`;
    if (isWholeFileChange(kind)) {
      blocks.push(formatDiffBlock(header, wholeFilePlaceholderDiff(kind, filePath)));
      continue;
    }

    const diff = String(change?.diff || "").trim();
    if (!diff) {
      continue;
    }
    blocks.push(formatDiffBlock(header, diff));
  }
  return blocks.join("\n\n");
}

function planItemText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean);
  return parts.join("").trim();
}

function trimToLimit(text, maxLen = 120_000) {
  const input = String(text || "");
  if (!input) {
    return "";
  }
  if (input.length <= maxLen) {
    return input;
  }
  return input.slice(input.length - maxLen);
}

function cacheKeyFromIds(threadId, turnId) {
  const turn = String(turnId || "").trim();
  if (turn) {
    return `turn:${turn}`;
  }
  const thread = String(threadId || "").trim();
  if (thread) {
    return `thread:${thread}`;
  }
  return "";
}

function hasWholeFileChanges(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.some((change) => isWholeFileChange(change?.kind));
}

function isUnifiedDiffText(text) {
  const input = String(text || "");
  return /(^|\n)(diff --git |@@ |--- |\+\+\+ )/.test(input);
}

function shortHash(text) {
  return createHash("sha1").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonApp {
  constructor({ baseDir } = {}) {
    this.store = new StateStore({ baseDir });
    this.config = this.store.readConfig();

    this.logger = createLogger({
      filePath: path.join(this.store.logsDir, "daemon.log"),
      level: process.env.IM_CODEX_LOG_LEVEL || "info",
    });

    const outputConfig = this.config.defaults?.output || {};
    this.outputPolicy = {
      resumeHistoryTurns: toInt(outputConfig.resumeHistoryTurns, 3, 1, 100),
      chatHistoryFlushIntervalMs: toInt(outputConfig.chatHistoryFlushIntervalMs, 250, 10, 10_000),
      turnOutputMinChunkChars: toInt(outputConfig.turnOutputMinChunkChars, 160, 40, 8_000),
      turnOutputSoftChunkChars: toInt(outputConfig.turnOutputSoftChunkChars, 280, 40, 8_000),
      liveSectionMaxLen: toInt(outputConfig.liveSectionMaxLen, 1400, 200, 1900),
      liveSectionDelayMs: toInt(outputConfig.liveSectionDelayMs, 250, 0, 10_000),
      discord: {
        replyToUser: Boolean(outputConfig.discord?.replyToUser ?? true),
        useLiveEdits: Boolean(outputConfig.discord?.useLiveEdits ?? true),
        statusEditIntervalMs: toInt(outputConfig.discord?.statusEditIntervalMs, 500, 50, 10_000),
        statusMessageMaxLen: toInt(outputConfig.discord?.statusMessageMaxLen, 1600, 200, 1900),
        toolProgressMode: normalizeToolProgressMode(outputConfig.discord?.toolProgressMode),
        toolOutputTailLines: toInt(outputConfig.discord?.toolOutputTailLines, 8, 1, 50),
        finalMessageMaxLen: toInt(outputConfig.discord?.finalMessageMaxLen, 1600, 200, 1900),
        finalMessageDelayMs: toInt(outputConfig.discord?.finalMessageDelayMs, 350, 0, 10_000),
      },
    };

    this.chatHistoryPath = path.join(this.store.logsDir, "chat-history.jsonl");
    this.chatHistoryBuffer = [];
    this.chatHistoryFlushTimer = null;
    this.chatHistoryFlushChain = Promise.resolve();

    this.runtime = new AppServerRuntime({
      launchSpec: makeLaunchSpec(this.config),
      logger: this.logger,
      reconnect: true,
    });

    this.approvalBroker = new ApprovalBroker({ timeoutMs: 5 * 60 * 1000 });
    this.autopilotSupervisor = null;
    this.adapters = [];

    this.threadToBinding = new Map();
    this.turnToBinding = new Map();
    this.activeTurnByBinding = new Map();
    this.suppressedTurnIds = new Set();
    this.turnTextByKey = new Map();
    this.discordTurnStateByTurnId = new Map();
    this.deliveredFileChangeItemIds = new Set();
    this.fileChangeOutputByItemId = new Map();
    this.latestTurnDiffByKey = new Map();
    this.deliveredTurnDiffByKey = new Set();
    this.threadListStateByBinding = new Map();
    this.skillsCacheByCwd = new Map();
    this.recentControlCommandByKey = new Map();

    this.running = false;
  }

  async start() {
    this.running = true;
    this.#ensureAutopilotSupervisor();

    this.#wireRuntimeEvents();
    this.#wireApprovalBroker();

    await this.runtime.initialize();
    this.logger.info("runtime initialized");
    await this.#rehydrateRuntimeState("startup");

    await this.#startAdapters();
    await this.#announceRestoredBindings();
    this.logger.info("adapters started", this.adapters.map((adapter) => adapter.channel).join(","));

    this.store.appendAudit({ type: "daemon_started", pid: process.pid });
  }

  async stop() {
    this.running = false;
    this.approvalBroker.clearAll();
    this.autopilotSupervisor = null;
    this.#resetEphemeralTurnState();

    for (const adapter of this.adapters) {
      await adapter.stop();
    }

    await this.#flushChatHistory({ force: true });
    await this.store.flush();
    await this.runtime.stop();
    this.store.appendAudit({ type: "daemon_stopped", pid: process.pid });
    await this.store.flush();
  }

  #wireRuntimeEvents() {
    this.runtime.on("notification", (notification) => {
      this.#handleRuntimeNotification(notification).catch((error) => {
        this.logger.error("failed to handle runtime notification", error);
      });
    });

    this.runtime.on("serverRequest", (request) => {
      this.#handleServerRequest(request).catch((error) => {
        this.logger.error("failed to handle server request", error);
      });
    });

    this.runtime.on("stderr", (line) => {
      this.logger.debug("runtime stderr:", line.trim());
    });

    this.runtime.on("error", (error) => {
      this.logger.error("runtime error", error);
    });

    this.runtime.on("reconnected", () => {
      this.logger.warn("runtime reconnected");
      this.#rehydrateRuntimeState("reconnected").catch((error) => {
        this.logger.error("runtime state reconciliation failed after reconnect", error);
      });
    });
  }

  async #rehydrateRuntimeState(reason) {
    this.#resetEphemeralTurnState();
    const summary = await reconcileRuntimeState({
      store: this.store,
      runtime: this.runtime,
      logger: this.logger,
      threadToBinding: this.threadToBinding,
      turnToBinding: this.turnToBinding,
      activeTurnByBinding: this.activeTurnByBinding,
      bindingKeyFn: bindingKey,
      isThreadNotFoundError,
      extractThreadCwd,
      resumeThread: (threadId) => this.runtime.resumeThread(threadId),
    });
    this.store.appendAudit({
      type: "runtime_state_rehydrated",
      reason,
      ...summary,
    });
    this.logger.info(
      `runtime state reconciled (${reason}): loaded=${summary.loadedCount}, verified=${summary.verifiedThreads}, cwd_updated=${summary.refreshedCwd}, stale_cleared=${summary.clearedBindings}`
    );
  }

  #wireApprovalBroker() {
    this.approvalBroker.on("resolved", async (resolution) => {
      const { record } = resolution;
      this.store.resolvePendingApproval(resolution.localRequestId, {
        decision: resolution.decision,
        actor: resolution.actor || "system",
      });

      this.store.appendAudit({
        type: "approval_resolved",
        localRequestId: resolution.localRequestId,
        decision: resolution.decision,
        method: record.method,
      });

      await this.runtime.respondServerRequest(record.serverRequestId, resolution.response);

      const turnId = detectTurnId(record.params);
      const context = this.#runtimeContext(
        record.binding.channel,
        record.binding.chatId,
        null,
        turnId
      );
      const adapter = this.#getAdapter(record.binding.channel);
      if (adapter) {
        let text = resolution.timeout
          ? `Approval timed out (${resolution.localRequestId}); defaulted to deny.`
          : `Approval ${resolution.decision === "allow" ? "granted" : "denied"} (${resolution.localRequestId}).`;
        if (!resolution.timeout && resolution.actor === "autopilot") {
          if (record.method === "item/tool/requestUserInput" && resolution.decision === "allow") {
            text = `Autopilot answered tool input (${resolution.localRequestId}).`;
          } else {
            text = `Autopilot ${resolution.decision === "allow" ? "approved" : "denied"} ${record.method} (${resolution.localRequestId}).`;
          }
        }
        await this.#sendMessage(adapter, context, text);
      }

      this.store.deletePendingApproval(resolution.localRequestId);
    });
  }

  #ensureAutopilotSupervisor() {
    this.autopilotSupervisor = new AutopilotSupervisor({
      store: this.store,
      approvalBroker: this.approvalBroker,
      logger: this.logger,
      startFollowupTurn: (binding, prompt) => this.#startAutopilotFollowupTurn(binding, prompt),
    });
  }

  async #startAutopilotFollowupTurn(binding, prompt) {
    const adapter = this.#getAdapter(binding.channel);
    if (!adapter) {
      throw new Error(`No adapter available for ${binding.channel}`);
    }
    const bKey = bindingKey(binding.channel, binding.chatId);
    const context = this.#contextFromBinding(binding);
    const started = await this.#startTurnWithRecovery(
      adapter,
      context,
      binding,
      bKey,
      prompt,
      {}
    );
    if (!started) {
      throw new Error("Failed to start autopilot follow-up turn");
    }
    const { threadId, turnResponse } = started;
    const turnId = turnIdFromResponse(turnResponse);
    if (turnId) {
      this.turnToBinding.set(turnId, bKey);
      this.activeTurnByBinding.set(bKey, turnId);
      if (adapter.channel === "discord") {
        const state = this.#ensureDiscordTurnState({
          bindingKeyValue: bKey,
          threadId,
          turnId,
          inboundContext: context,
        });
        if (state && this.outputPolicy.discord.useLiveEdits) {
          await this.#openDiscordLiveSegment(
            adapter,
            this.#runtimeContext(binding.channel, binding.chatId, threadId, turnId),
            state,
            "Autopilot continuing...",
            "status"
          );
        }
      }
    }
    this.store.appendAudit({
      type: "turn_started_autopilot",
      channel: binding.channel,
      chatId: binding.chatId,
      threadId,
      turnId,
    });
    if (adapter) {
      await this.#sendMessage(
        adapter,
        context,
        `Autopilot started a follow-up turn${turnId ? ` (${turnId})` : ""}.`
      );
    }
    return { threadId, turnId };
  }

  async #startAdapters() {
    const channels = this.config.channels || {};

    if (channels.discord?.enabled && channels.discord.botToken) {
      const discord = new DiscordAdapter({
        token: channels.discord.botToken,
        allowedChannels: channels.discord.allowedChannels || [],
        dmUserIds: channels.discord.allowlist || [],
        loadCursor: (chatId) => this.store.getChannelCursor("discord", chatId),
        saveCursor: (chatId, cursor) => this.store.setChannelCursor("discord", chatId, cursor),
        authorizeInteraction: (context) => this.#isAuthorizedInteractiveContext(context),
        logger: this.logger,
      });
      this.adapters.push(discord);
    }

    for (const adapter of this.adapters) {
      if (typeof adapter.registerInboundHandler === "function") {
        adapter.registerInboundHandler((context) => {
          this.#handleInboundSafe(context).catch((error) => this.logger.error(`${adapter.channel} inbound failed`, error));
        });
      }
      await adapter.start();
    }
  }

  async #announceRestoredBindings() {
    const bindings = this.store.listBindings().filter((binding) => binding?.threadId);
    for (const binding of bindings) {
      const adapter = this.#getAdapter(binding.channel);
      if (!adapter) {
        continue;
      }
      try {
        const context = this.#runtimeContext(binding.channel, binding.chatId, null, null);
        await this.#sendMessage(
          adapter,
          context,
          binding.workingDir
            ? `Restored thread context: ${binding.threadId}\nWorkspace set to: ${binding.workingDir}`
            : `Restored thread context: ${binding.threadId}`
        );
      } catch (error) {
        this.logger.warn(`failed to announce restored binding ${bindingKey(binding.channel, binding.chatId)}: ${error.message}`);
      }
    }
  }

  #channelAllowlist(channel) {
    return this.config.channels?.[channel]?.allowlist || [];
  }

  #ensureBinding(context) {
    const existing = this.store.getBinding(context.channel, context.chatId);
    if (existing) {
      return existing;
    }

    const created = this.store.upsertBinding({
      channel: context.channel,
      chatId: context.chatId,
      userId: context.userId,
      threadId: null,
      workingDir: this.config.defaults?.workingDir || process.cwd(),
      policyProfile: {
        approvalMode: this.config.defaults?.approvalMode || "on-request",
        allowlist: this.#channelAllowlist(context.channel),
        autoApprove: false,
        collaborationMode: "default",
        threadAutoApproveByThreadId: {},
        threadPlanModeByThreadId: {},
      },
    });

    this.store.appendAudit({
      type: "binding_created",
      channel: context.channel,
      chatId: context.chatId,
    });

    return created;
  }

  #contextFromBinding(binding) {
    return {
      channel: binding.channel,
      chatId: binding.chatId,
      userId: binding.userId || "",
      turnId: null,
      messageId: null,
      replyToMessageId: null,
      threadId: null,
    };
  }

  #isAuthorized(binding, context) {
    const allowlist = binding.policyProfile?.allowlist || [];
    if (!allowlist.length) {
      return false;
    }
    return allowlist.includes(String(context.userId));
  }

  #isAuthorizedInteractiveContext(context) {
    const existing = this.store.getBinding(context.channel, context.chatId);
    if (existing) {
      return this.#isAuthorized(existing, context);
    }
    const allowlist = this.#channelAllowlist(context.channel) || [];
    return allowlist.includes(String(context.userId || ""));
  }

  #getAdapter(channel) {
    return this.adapters.find((adapter) => adapter.channel === channel) || null;
  }

  #threadPlanModeMap(binding) {
    const raw = binding?.policyProfile?.threadPlanModeByThreadId;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const out = {};
    for (const [threadId, enabled] of Object.entries(raw)) {
      const id = String(threadId || "").trim();
      if (!id) {
        continue;
      }
      out[id] = Boolean(enabled);
    }
    return out;
  }

  #threadPlanEnabled(binding, threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return false;
    }
    return Boolean(this.#threadPlanModeMap(binding)[id]);
  }

  #setThreadPlanMode(binding, threadId, enabled) {
    const id = String(threadId || "").trim();
    if (!id) {
      return binding;
    }
    const nextMap = this.#threadPlanModeMap(binding);
    if (enabled) {
      nextMap[id] = true;
    } else {
      delete nextMap[id];
    }
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        collaborationMode: "default",
        threadPlanModeByThreadId: nextMap,
      },
    });
  }

  #clearThreadPlanModeForThread(binding, threadId) {
    if (!binding) {
      return null;
    }
    const id = String(threadId || "").trim();
    if (!id) {
      return binding;
    }
    const nextMap = this.#threadPlanModeMap(binding);
    if (!nextMap[id]) {
      return binding;
    }
    delete nextMap[id];
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        threadPlanModeByThreadId: nextMap,
      },
    });
  }

  #effectiveCollaborationMode(binding, threadId, override = undefined) {
    if (override !== undefined) {
      return override;
    }
    if (this.#threadPlanEnabled(binding, threadId)) {
      return "plan";
    }
    const sticky = String(binding?.policyProfile?.collaborationMode || "").trim().toLowerCase();
    if (!sticky || sticky === "default" || sticky === "plan") {
      return "default";
    }
    return binding.policyProfile.collaborationMode;
  }

  #threadAutoApproveMap(binding) {
    const raw = binding?.policyProfile?.threadAutoApproveByThreadId;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const out = {};
    for (const [threadId, enabled] of Object.entries(raw)) {
      const id = String(threadId || "").trim();
      if (!id) {
        continue;
      }
      out[id] = Boolean(enabled);
    }
    return out;
  }

  #threadAutoApproveEnabled(binding, threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return false;
    }
    return Boolean(this.#threadAutoApproveMap(binding)[id]);
  }

  #setThreadAutoApprove(binding, threadId, enabled) {
    const id = String(threadId || "").trim();
    if (!id) {
      return binding;
    }
    const nextMap = this.#threadAutoApproveMap(binding);
    if (enabled) {
      nextMap[id] = true;
    } else {
      delete nextMap[id];
    }
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        threadAutoApproveByThreadId: nextMap,
      },
    });
  }

  #clearThreadAutoApproveForThread(binding, threadId) {
    if (!binding) {
      return null;
    }
    const id = String(threadId || "").trim();
    if (!id) {
      return binding;
    }
    const nextMap = this.#threadAutoApproveMap(binding);
    if (!nextMap[id]) {
      return binding;
    }
    delete nextMap[id];
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        threadAutoApproveByThreadId: nextMap,
      },
    });
  }

  #claimThreadForBinding(binding, threadId, { workingDir } = {}) {
    if (!binding) {
      return null;
    }

    const id = String(threadId || "").trim();
    if (!id) {
      return binding;
    }

    const targetKey = bindingKey(binding.channel, binding.chatId);
    const previousThreadId = String(binding.threadId || "").trim();
    if (previousThreadId && previousThreadId !== id && this.threadToBinding.get(previousThreadId) === targetKey) {
      this.threadToBinding.delete(previousThreadId);
    }

    for (const existing of this.store.listBindings()) {
      const existingKey = bindingKey(existing.channel, existing.chatId);
      if (existingKey === targetKey) {
        continue;
      }
      if (String(existing.threadId || "").trim() !== id) {
        continue;
      }

      this.store.upsertBinding({
        ...existing,
        threadId: null,
      });
      this.activeTurnByBinding.delete(existingKey);
      this.#turnOutputClearByBinding(existingKey);
      this.#discordTurnStateClearByBinding(existingKey);
      for (const [turnId, mappedKey] of this.turnToBinding.entries()) {
        if (mappedKey === existingKey) {
          this.turnToBinding.delete(turnId);
        }
      }
    }

    this.threadToBinding.set(id, targetKey);
    const updated = this.store.upsertBinding({
      ...binding,
      threadId: id,
      ...(workingDir ? { workingDir } : {}),
    });
    return updated;
  }

  #findPendingToolInputRequest(binding, { requestId = "", preferredThreadId = "" } = {}) {
    const targetRequestId = String(requestId || "").trim();
    if (targetRequestId) {
      const pending = this.approvalBroker.getPending(targetRequestId);
      if (!pending || pending.method !== "item/tool/requestUserInput") {
        return null;
      }
      const matchesBinding = (
        String(pending.binding?.channel || "") === String(binding.channel || "")
        && String(pending.binding?.chatId || "") === String(binding.chatId || "")
      );
      return matchesBinding ? pending : null;
    }

    const requestedThreadId = String(preferredThreadId || "").trim();
    const candidates = this.approvalBroker
      .listPending()
      .filter((record) => (
        record.method === "item/tool/requestUserInput"
        && String(record.binding?.channel || "") === String(binding.channel || "")
        && String(record.binding?.chatId || "") === String(binding.chatId || "")
      ));
    if (!candidates.length) {
      return null;
    }
    if (!requestedThreadId) {
      return candidates[candidates.length - 1];
    }

    const exact = candidates.filter((record) => String(detectThreadId(record.params) || "").trim() === requestedThreadId);
    return exact[exact.length - 1] || candidates[candidates.length - 1];
  }

  #resetEphemeralTurnState() {
    this.turnToBinding.clear();
    this.activeTurnByBinding.clear();
    this.turnTextByKey.clear();
    this.discordTurnStateByTurnId.clear();
    this.suppressedTurnIds.clear();
  }

  #appendChatHistory(entry) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    this.chatHistoryBuffer.push(line);
    this.#scheduleChatHistoryFlush();
  }

  #scheduleChatHistoryFlush() {
    if (this.chatHistoryFlushTimer) {
      return;
    }
    this.chatHistoryFlushTimer = setTimeout(() => {
      this.chatHistoryFlushTimer = null;
      this.#flushChatHistory().catch((error) => {
        this.logger?.warn?.(`failed to flush chat history: ${error.message}`);
      });
    }, this.outputPolicy.chatHistoryFlushIntervalMs);
  }

  async #flushChatHistory({ force = false } = {}) {
    if (this.chatHistoryFlushTimer && force) {
      clearTimeout(this.chatHistoryFlushTimer);
      this.chatHistoryFlushTimer = null;
    }
    if (!this.chatHistoryBuffer.length) {
      if (force) {
        await this.chatHistoryFlushChain.catch(() => {});
      }
      return;
    }

    const batch = this.chatHistoryBuffer.splice(0, this.chatHistoryBuffer.length);
    const payload = `${batch.join("\n")}\n`;
    const filePath = String(this.chatHistoryPath || "");
    const writeTask = this.chatHistoryFlushChain
      .catch(() => {})
      .then(() => fsp.appendFile(filePath, payload, { encoding: "utf8" }));
    this.chatHistoryFlushChain = writeTask.catch(() => {});

    try {
      await writeTask;
    } catch (error) {
      if (force) {
        try {
          fs.appendFileSync(filePath, payload, { encoding: "utf8" });
          return;
        } catch (syncError) {
          this.logger?.warn?.(`failed to force-flush chat history: ${syncError.message}`);
        }
      } else {
        this.logger?.warn?.(`failed to append chat history: ${error.message}`);
      }
      this.chatHistoryBuffer = [...batch, ...this.chatHistoryBuffer];
      this.#scheduleChatHistoryFlush();
    }
  }

  async #sendMessage(adapter, context, text) {
    this.#appendChatHistory({
      direction: "outbound",
      type: "message",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      text: String(text || ""),
    });
    return this.#sendAdapterMessage(adapter, context, { text: String(text || "") });
  }

  async #sendRichMessage(adapter, context, payload = {}) {
    this.#appendChatHistory({
      direction: "outbound",
      type: "message",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      text: String(payload?.text || ""),
    });
    return this.#sendAdapterMessage(adapter, context, payload);
  }

  async #sendMessageRaw(adapter, context, text) {
    return this.#sendAdapterMessage(adapter, context, { text: String(text || "") });
  }

  async #sendLongMessage(adapter, context, text, { maxLen = 1600, delayMs = 350 } = {}) {
    const chunks = splitTextIntoChunks(text, maxLen);
    if (!chunks.length) {
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.#sendMessage(adapter, context, chunk);
      if (delayMs > 0 && index < chunks.length - 1) {
        await sleep(delayMs);
      }
    }
  }

  async #sendLongMessageRaw(adapter, context, text, { maxLen = 1600, delayMs = 350 } = {}) {
    const chunks = splitTextIntoChunks(text, maxLen);
    if (!chunks.length) {
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.#sendMessageRaw(adapter, context, chunk);
      if (delayMs > 0 && index < chunks.length - 1) {
        await sleep(delayMs);
      }
    }
  }

  async #sendStreamingDelta(adapter, context, delta) {
    this.#appendChatHistory({
      direction: "outbound",
      type: "stream_delta",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      text: String(delta || ""),
    });
    await adapter.sendStreamingDelta(context, delta);
  }

  async #sendAdapterMessage(adapter, context, payload = {}) {
    const richSupported = typeof adapter.sendMessageRich === "function";
    if (richSupported) {
      return adapter.sendMessageRich(context, payload);
    }
    return adapter.sendMessage(context, payload.text || "");
  }

  async #editAdapterMessage(adapter, context, messageId, text) {
    if (typeof adapter.editMessage !== "function") {
      return null;
    }
    try {
      return await adapter.editMessage(context, messageId, text);
    } catch {
      return null;
    }
  }

  #discordTurnState(turnId) {
    const id = String(turnId || "").trim();
    if (!id) {
      return null;
    }
    return this.discordTurnStateByTurnId.get(id) || null;
  }

  #ensureDiscordTurnState({ bindingKeyValue, threadId, turnId, inboundContext } = {}) {
    const id = String(turnId || "").trim();
    if (!id) {
      return null;
    }

    const existing = this.discordTurnStateByTurnId.get(id);
    if (existing) {
      existing.bindingKey = bindingKeyValue || existing.bindingKey;
      existing.threadId = String(threadId || existing.threadId || "");
      if (inboundContext) {
        existing.replyToMessageId = String(
          inboundContext.replyToMessageId
          || inboundContext.messageId
          || existing.replyToMessageId
          || ""
        );
        existing.threadIdHint = String(inboundContext.threadId || existing.threadIdHint || "");
        existing.originChatId = String(inboundContext.chatId || existing.originChatId || "");
        if (inboundContext.messageId || inboundContext.replyToMessageId) {
          existing.presentationEnabled = true;
        }
        if (inboundContext.discordMeta?.kind === "slash" && !inboundContext.discordMeta?.responded) {
          existing.interactionMeta = inboundContext.discordMeta;
        }
      }
      return existing;
    }

    const created = {
      bindingKey: bindingKeyValue || "",
      threadId: String(threadId || ""),
      turnId: id,
      replyToMessageId: String(inboundContext?.replyToMessageId || inboundContext?.messageId || ""),
      threadIdHint: String(inboundContext?.threadId || ""),
      originChatId: String(inboundContext?.chatId || ""),
      presentationEnabled: Boolean(
        inboundContext
        && (inboundContext.messageId || inboundContext.replyToMessageId)
      ),
      interactionMeta: inboundContext?.discordMeta?.kind === "slash" ? inboundContext.discordMeta : null,
      liveMessageId: "",
      liveMessageChatId: "",
      liveSegmentKind: "",
      currentAssistantSegmentText: "",
      assistantFullText: "",
      assistantShownLength: 0,
      liveEditsDisabled: false,
      turnEditsDisabled: false,
      pendingBoundary: false,
      lastLiveEditAt: 0,
      lastToolHash: "",
      recentToolActivities: [],
      pendingStatusRenderTimer: null,
      lastStatusText: "",
      commandOutputsByItemId: new Map(),
      toolMessagesByItemId: new Map(),
      planMessageId: "",
      planMessageChatId: "",
      planText: "",
    };
    this.discordTurnStateByTurnId.set(id, created);
    return created;
  }

  #clearDiscordTurnState(turnId) {
    const id = String(turnId || "").trim();
    if (!id) {
      return null;
    }
    const state = this.discordTurnStateByTurnId.get(id) || null;
    if (state?.pendingStatusRenderTimer) {
      clearTimeout(state.pendingStatusRenderTimer);
      state.pendingStatusRenderTimer = null;
    }
    this.discordTurnStateByTurnId.delete(id);
    return state;
  }

  #runtimeContext(channel, chatId, threadId, turnId) {
    const context = {
      channel,
      chatId,
      threadId: threadId || null,
      turnId: turnId || null,
    };
    const state = this.#discordTurnState(turnId);
    if (state) {
      context.replyToMessageId = state.replyToMessageId || null;
      if (state.threadIdHint) {
        context.threadId = state.threadIdHint;
      }
      if (state.interactionMeta && !state.interactionMeta.responded) {
        context.discordMeta = state.interactionMeta;
      }
    }
    return context;
  }

  #discordProgressContext(channel, chatId, threadId, turnId) {
    const context = this.#runtimeContext(channel, chatId, threadId, turnId);
    context.replyToMessageId = null;
    return context;
  }

  #discordFinalContext(channel, chatId, threadId, turnId) {
    const context = this.#runtimeContext(channel, chatId, threadId, turnId);
    if (!this.outputPolicy.discord.replyToUser) {
      context.replyToMessageId = null;
    }
    return context;
  }

  #composeDiscordStatusText(state, baseText = "Working on it...") {
    const base = String(baseText || "Working on it...").trim() || "Working on it...";
    const recent = Array.isArray(state?.recentToolActivities)
      ? state.recentToolActivities.filter(Boolean).slice(-4)
      : [];
    if (!recent.length) {
      return base;
    }
    return [
      base,
      "",
      "Recent activity:",
      ...recent.map((line) => `- ${line}`),
    ].join("\n");
  }

  async #renderDiscordStatusSegment(adapter, channel, chatId, threadId, turnId, { force = false } = {}) {
    const state = this.#discordTurnState(turnId);
    if (!state || state.turnEditsDisabled || state.liveEditsDisabled) {
      return false;
    }

    const text = this.#composeDiscordStatusText(state);
    if (!text) {
      return false;
    }
    if (state.pendingStatusRenderTimer && force) {
      clearTimeout(state.pendingStatusRenderTimer);
      state.pendingStatusRenderTimer = null;
    }
    if (!force && text === state.lastStatusText) {
      return false;
    }

    const context = this.#runtimeContext(channel, chatId, threadId, turnId);
    if (!state.liveMessageId) {
      await this.#openDiscordLiveSegment(adapter, context, state, text, "status");
      state.lastStatusText = text;
      return true;
    }

    const sinceLastEdit = Date.now() - state.lastLiveEditAt;
    if (!force && sinceLastEdit < this.outputPolicy.discord.statusEditIntervalMs) {
      if (!state.pendingStatusRenderTimer) {
        state.pendingStatusRenderTimer = setTimeout(async () => {
          const latest = this.#discordTurnState(turnId);
          if (latest) {
            latest.pendingStatusRenderTimer = null;
          }
          await this.#renderDiscordStatusSegment(adapter, channel, chatId, threadId, turnId, { force: true });
        }, this.outputPolicy.discord.statusEditIntervalMs - sinceLastEdit);
      }
      return false;
    }

    const edited = await this.#editAdapterMessage(
      adapter,
      {
        ...context,
        chatId: state.liveMessageChatId || chatId,
        threadId: state.liveMessageChatId || context.threadId,
      },
      state.liveMessageId,
      text
    );
    if (!edited) {
      state.liveEditsDisabled = true;
      state.turnEditsDisabled = true;
      return false;
    }
    state.liveSegmentKind = "status";
    state.lastLiveEditAt = Date.now();
    state.lastStatusText = text;
    return true;
  }

  async #openDiscordLiveSegment(adapter, context, state, text, segmentKind = "assistant") {
    const payload = {
      text,
      replyToMessageId: null,
      threadId: state.threadIdHint || context.threadId || null,
    };
    const sent = await this.#sendMessage(adapter, {
      ...context,
      replyToMessageId: payload.replyToMessageId,
      threadId: payload.threadId,
    }, text);
    state.liveMessageId = sent?.messageId || "";
    state.liveMessageChatId = sent?.chatId || payload.threadId || context.chatId || "";
    state.liveSegmentKind = segmentKind;
    state.lastLiveEditAt = Date.now();
    return sent;
  }

  async #renderDiscordAssistantSegment(adapter, channel, chatId, threadId, turnId, { force = false } = {}) {
    const state = this.#discordTurnState(turnId);
    if (!state || state.turnEditsDisabled || state.liveEditsDisabled) {
      return false;
    }

    const text = String(state.currentAssistantSegmentText || "").trim();
    if (!text) {
      return false;
    }

    const context = this.#runtimeContext(channel, chatId, threadId, turnId);
    if (!state.liveMessageId) {
      await this.#openDiscordLiveSegment(adapter, context, state, text, "assistant");
      state.assistantShownLength = state.assistantFullText.length;
      return true;
    }

    if (state.liveSegmentKind !== "assistant" && state.liveSegmentKind !== "status") {
      await this.#openDiscordLiveSegment(adapter, context, state, text, "assistant");
      state.assistantShownLength = state.assistantFullText.length;
      return true;
    }

    if (
      !force
      && state.liveSegmentKind !== "status"
      && Date.now() - state.lastLiveEditAt < this.outputPolicy.discord.statusEditIntervalMs
    ) {
      return false;
    }

    const edited = await this.#editAdapterMessage(
      adapter,
      {
        ...context,
        chatId: state.liveMessageChatId || chatId,
        threadId: state.liveMessageChatId || context.threadId,
      },
      state.liveMessageId,
      text
    );
    if (!edited) {
      state.liveEditsDisabled = true;
      state.turnEditsDisabled = true;
      return false;
    }
    state.liveSegmentKind = "assistant";
    state.lastLiveEditAt = Date.now();
    state.assistantShownLength = state.assistantFullText.length;
    return true;
  }

  #closeDiscordAssistantSegment(turnId) {
    const state = this.#discordTurnState(turnId);
    if (!state) {
      return;
    }
    if (state.pendingStatusRenderTimer) {
      clearTimeout(state.pendingStatusRenderTimer);
      state.pendingStatusRenderTimer = null;
    }
    state.liveMessageId = "";
    state.liveMessageChatId = "";
    state.liveSegmentKind = "";
    state.currentAssistantSegmentText = "";
    state.liveEditsDisabled = false;
    state.turnEditsDisabled = false;
    state.pendingBoundary = false;
    state.lastLiveEditAt = 0;
    state.lastStatusText = "";
  }

  async #sendDiscordToolActivity(adapter, channel, chatId, threadId, turnId, item) {
    const state = this.#discordTurnState(turnId);
    if (!state) {
      return false;
    }
    const mode = this.outputPolicy.discord.toolProgressMode;
    const summary = summarizeToolActivity(item, { mode });
    if (!summary) {
      return false;
    }

    const nextHash = shortHash(`${item?.id || ""}:${summary}`);
    if (nextHash === state.lastToolHash) {
      return false;
    }
    state.lastToolHash = nextHash;
    const headline = firstLine(summary);
    if (!headline) {
      return false;
    }
    state.recentToolActivities.push(headline);
    if (state.recentToolActivities.length > 4) {
      state.recentToolActivities = state.recentToolActivities.slice(-4);
    }
    return this.#renderDiscordStatusSegment(adapter, channel, chatId, threadId, turnId);
  }

  async #sendDiscordPlanUpdate(adapter, channel, chatId, threadId, turnId, text) {
    const state = this.#discordTurnState(turnId);
    if (!state || !text) {
      return false;
    }
    const context = this.#discordProgressContext(channel, chatId, threadId, turnId);
    if (state.planText === text) {
      return false;
    }
    const sent = await this.#sendMessage(adapter, context, text);
    state.planMessageId = sent?.messageId || "";
    state.planMessageChatId = sent?.chatId || context.threadId || context.chatId;
    state.planText = text;
    return true;
  }

  async #sendDiscordCommandOutput(adapter, channel, chatId, threadId, turnId, itemId, delta) {
    return false;
  }

  async #sendApprovalPrompt(adapter, context, payload) {
    this.#appendChatHistory({
      direction: "outbound",
      type: "approval_prompt",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      turnId: context.turnId || null,
      requestId: payload?.localRequestId || null,
      summary: payload?.summary || "",
      kind: payload?.kind || "",
    });
    await adapter.sendApprovalPrompt(context, payload);
  }

  async #startFreshThreadForBinding(binding, bKey) {
    const response = await this.runtime.startThread({
      cwd: binding.workingDir,
      approvalPolicy: binding.policyProfile.approvalMode,
      model: binding.policyProfile.model || null,
    });
    const threadId = threadIdFromResponse(response);
    if (threadId) {
      const updated = this.#claimThreadForBinding(binding, threadId);
      Object.assign(binding, updated);
    }
    return threadId;
  }

  async #resolveThreadCwd(threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return "";
    }

    try {
      const read = await this.runtime.readThread({ threadId: id, includeTurns: false });
      const cwd = extractThreadCwd(read?.thread || read);
      if (cwd) {
        return cwd;
      }
    } catch {
      // continue to list fallback
    }

    try {
      const response = await this.runtime.listThreads({ limit: 200, archived: false });
      const threads = threadListFromResponse(response);
      const match = threads.find((thread) => extractThreadId(thread) === id);
      return extractThreadCwd(match);
    } catch {
      return "";
    }
  }

  #setThreadListState(bKey, state) {
    this.threadListStateByBinding.set(bKey, state);
  }

  #getThreadListState(bKey) {
    return this.threadListStateByBinding.get(bKey) || null;
  }

  async #renderThreadHistoryMessages(threadId, { turns = null, textLimit = null } = {}) {
    try {
      const read = await this.runtime.readThread({ threadId, includeTurns: true });
      const allTurns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
      const selectedTurns = Number.isFinite(Number(turns))
        ? allTurns.slice(-Math.max(0, Number(turns)))
        : allTurns;
      const startIndex = Math.max(0, allTurns.length - selectedTurns.length);
      if (!selectedTurns.length) {
        return [];
      }

      const messages = [];
      if (selectedTurns.length < allTurns.length) {
        messages.push(`Thread history (${selectedTurns.length}/${allTurns.length} turns shown):`);
      } else {
        messages.push(`Thread history (${allTurns.length} turns):`);
      }

      for (let index = 0; index < selectedTurns.length; index += 1) {
        const turn = selectedTurns[index];
        const lines = [];
        const userRaw = String(allUserTextFromTurn(turn) || "").trim();
        const agentRaw = String(allAgentTextFromTurn(turn) || "").trim();
        const userText = textLimit ? clipText(userRaw, textLimit) : userRaw;
        const agentText = textLimit ? clipText(agentRaw, textLimit) : agentRaw;
        lines.push(`Turn ${startIndex + index + 1}`);
        if (userText) {
          lines.push("User:");
          lines.push(quoteMarkdown(userText));
        }
        if (agentText) {
          lines.push("Assistant:");
          lines.push(agentText);
        }
        if (!userText && !agentText) {
          lines.push("(no visible text content)");
        }
        messages.push(lines.join("\n"));
      }

      return messages.filter(Boolean);
    } catch (error) {
      this.logger.debug(`failed to load thread history for ${threadId}: ${error.message}`);
      return [];
    }
  }

  async #sendThreadHistory(adapter, context, threadId, options = {}) {
    const messages = await this.#renderThreadHistoryMessages(threadId, options);
    if (!messages.length) {
      return;
    }
    for (let index = 0; index < messages.length; index += 1) {
      const historyBlock = String(messages[index] || "");
      if (historyBlock.length <= 1850) {
        await this.#sendMessage(adapter, context, historyBlock);
      } else {
        await this.#sendLongMessage(adapter, context, historyBlock, {
          maxLen: 1850,
          delayMs: adapter.channel === "discord" ? 300 : 0,
        });
      }
      if (adapter.channel === "discord" && index < messages.length - 1) {
        await sleep(220);
      }
    }
  }

  async #loadSkillsForCwd(cwd, { forceReload = false } = {}) {
    const key = String(cwd || "");
    if (!key) {
      return { skills: [], errors: [] };
    }

    if (!forceReload && this.skillsCacheByCwd.has(key)) {
      return this.skillsCacheByCwd.get(key);
    }

    const response = await this.runtime.listSkills({
      cwds: [key],
      forceReload,
    });
    const entries = skillsEntriesFromResponse(response);
    const row = entries.find((item) => String(item?.cwd || "") === key) || entries[0] || {};
    const payload = {
      skills: Array.isArray(row?.skills) ? row.skills : [],
      errors: Array.isArray(row?.errors) ? row.errors : [],
    };
    this.skillsCacheByCwd.set(key, payload);
    return payload;
  }

  #touchSkillsContext(binding, cwd, skills) {
    const compact = (Array.isArray(skills) ? skills : []).slice(0, 200).map((skill) => ({
      name: skill?.name || "",
      path: skill?.path || "",
      enabled: Boolean(skill?.enabled),
      scope: skill?.scope || "",
    }));
    return this.store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        skillsContext: {
          cwd,
          count: compact.length,
          updatedAt: new Date().toISOString(),
          skills: compact,
        },
      },
    });
  }

  async #resolveSkillByName(binding, cwd, name, { forceReload = false } = {}) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const { skills } = await this.#loadSkillsForCwd(cwd, { forceReload });
    this.#touchSkillsContext(binding, cwd, skills);
    return skills.find((skill) => String(skill?.name || "").toLowerCase() === needle) || null;
  }

  async #buildTurnInput(adapter, context, binding, prompt, cwd) {
    const text = String(prompt || "").trim();
    const baseInput = [{ type: "text", text }];

    const skillName = extractSkillNameFromPrompt(text);
    if (!skillName) {
      return baseInput;
    }

    const skill = await this.#resolveSkillByName(binding, cwd, skillName);
    if (!skill?.path) {
      return baseInput;
    }

    await this.#sendMessage(adapter, context, `Auto-attached skill: ${skill.name}`);
    return [
      { type: "text", text },
      { type: "skill", name: skill.name, path: skill.path },
    ];
  }

  async #startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides = {}) {
    let threadId = binding.threadId;
    if (!threadId) {
      threadId = await this.#startFreshThreadForBinding(binding, bKey);
    }

    if (!threadId) {
      await this.#sendMessage(adapter, context, "Failed to obtain a thread id.");
      return null;
    }

    const cwd = overrides.cwd || binding.workingDir;
    const input = overrides.input || await this.#buildTurnInput(adapter, context, binding, prompt, cwd);
    const baseParams = {
      input,
      approvalPolicy: binding.policyProfile.approvalMode,
      cwd,
      model: overrides.model ?? binding.policyProfile.model ?? null,
      effort: overrides.effort ?? binding.policyProfile.reasoningEffort ?? null,
      collaborationMode: this.#effectiveCollaborationMode(
        binding,
        threadId,
        overrides.collaborationMode
      ),
    };

    return startTurnWithRecovery({
      threadId,
      baseParams,
      startTurn: (params) => this.runtime.startTurn(params),
      resumeThread: (candidateThreadId) => this.runtime.resumeThread(candidateThreadId),
      startFreshThread: async () => {
        this.logger.warn(`stale thread detected for ${bKey}: ${threadId}`);
        this.threadToBinding.delete(threadId);
        await this.#sendMessage(adapter, context, `Thread expired: ${threadId}. Starting a new thread...`);
        const freshThreadId = await this.#startFreshThreadForBinding(binding, bKey);
        if (!freshThreadId) {
          await this.#sendMessage(adapter, context, "Failed to recover thread. Run /new and retry.");
          return null;
        }
        return freshThreadId;
      },
      isThreadNotFoundError,
      onRecovered: async ({ threadId: recoveredThreadId, resumeResponse }) => {
        this.logger.warn(`thread not found on turn/start for ${bKey}: ${recoveredThreadId}; attempting resume`);
        let resumedCwd = extractThreadCwd(resumeResponse);
        if (!resumedCwd) {
          resumedCwd = await this.#resolveThreadCwd(recoveredThreadId);
        }
        const updated = this.#claimThreadForBinding(binding, recoveredThreadId, {
          ...(resumedCwd ? { workingDir: resumedCwd } : {}),
        });
        Object.assign(binding, updated);
        await this.#sendMessage(
          adapter,
          context,
          resumedCwd
            ? `Restored thread context: ${recoveredThreadId}\nWorkspace set to: ${resumedCwd}`
            : `Restored thread context: ${recoveredThreadId}`
        );
      },
      onRecoveredRetryMissing: async ({ threadId: recoveredThreadId }) => {
        this.logger.warn(`recovered thread still not startable for ${bKey}: ${recoveredThreadId}`);
      },
    });
  }

  #turnTextKeys(threadId, turnId) {
    const candidates = [turnOutputKey(threadId, turnId)];
    const turnOnly = turnOutputKey("", turnId);
    const threadOnly = turnOutputKey(threadId, "");
    if (turnOnly && !candidates.includes(turnOnly)) {
      candidates.push(turnOnly);
    }
    if (threadOnly && !candidates.includes(threadOnly)) {
      candidates.push(threadOnly);
    }
    return candidates.filter(Boolean);
  }

  #getOrCreateTurnTextState(threadId, turnId, bindingKeyValue) {
    const keys = this.#turnTextKeys(threadId, turnId);
    if (!keys.length) {
      return null;
    }

    for (const key of keys) {
      const existing = this.turnTextByKey.get(key);
      if (!existing) {
        continue;
      }
      existing.bindingKey = bindingKeyValue || existing.bindingKey;
      existing.threadId = String(threadId || existing.threadId || "");
      existing.turnId = String(turnId || existing.turnId || "");
      if (key !== keys[0]) {
        this.turnTextByKey.delete(key);
        this.turnTextByKey.set(keys[0], existing);
      }
      return existing;
    }

    const created = {
      bindingKey: bindingKeyValue,
      threadId: String(threadId || ""),
      turnId: String(turnId || ""),
      assistantText: "",
      publishedUntil: 0,
      deliveredUntil: 0,
    };
    this.turnTextByKey.set(keys[0], created);
    return created;
  }

  #takeTurnTextState(threadId, turnId) {
    const keys = this.#turnTextKeys(threadId, turnId);
    for (const key of keys) {
      const existing = this.turnTextByKey.get(key);
      if (!existing) {
        continue;
      }
      this.turnTextByKey.delete(key);
      return existing;
    }
    return null;
  }

  #turnOutputAppendDelta(threadId, turnId, bindingKeyValue, delta) {
    const state = this.#getOrCreateTurnTextState(threadId, turnId, bindingKeyValue);
    if (!state || !delta) {
      return { sectionText: "" };
    }

    state.assistantText += String(delta || "");
    const scanned = boundaryScan(state.assistantText, {
      minChunkChars: this.outputPolicy.turnOutputMinChunkChars,
      after: state.deliveredUntil,
    });
    let nextBoundary = Math.max(scanned.hardBoundary, state.publishedUntil);

    if (nextBoundary <= state.deliveredUntil) {
      const softScan = boundaryScan(state.assistantText, {
        minChunkChars: this.outputPolicy.turnOutputSoftChunkChars,
        after: state.deliveredUntil,
      });
      if (!softScan.inFence && softScan.softBoundary > state.deliveredUntil) {
        nextBoundary = softScan.softBoundary;
      }
    }

    if (nextBoundary <= state.deliveredUntil) {
      return { sectionText: "" };
    }

    const sectionText = state.assistantText
      .slice(state.deliveredUntil, nextBoundary)
      .trimEnd();

    state.publishedUntil = nextBoundary;
    if (sectionText) {
      state.deliveredUntil = nextBoundary;
    }

    return { sectionText };
  }

  #turnOutputTakeFinal(threadId, turnId) {
    const state = this.#takeTurnTextState(threadId, turnId);
    const fullText = String(state?.assistantText || "");
    const pendingText = String(fullText.slice(state?.deliveredUntil || 0) || "").trimEnd();
    return { fullText, pendingText };
  }

  #turnOutputClearByBinding(bindingKeyValue) {
    if (!bindingKeyValue) {
      return;
    }
    for (const [key, value] of this.turnTextByKey.entries()) {
      if (value?.bindingKey === bindingKeyValue) {
        this.turnTextByKey.delete(key);
      }
    }
  }

  #discordTurnStateClearByBinding(bindingKeyValue) {
    if (!bindingKeyValue) {
      return;
    }
    for (const [turnId, state] of this.discordTurnStateByTurnId.entries()) {
      if (state?.bindingKey === bindingKeyValue) {
        this.discordTurnStateByTurnId.delete(turnId);
      }
    }
  }

  #markDeliveryOnce(key) {
    const dedupeKey = String(key || "").trim();
    if (!dedupeKey) {
      return true;
    }
    const mark = this.store?.markDeliveryOnce;
    if (typeof mark !== "function") {
      return true;
    }
    try {
      return Boolean(mark.call(this.store, dedupeKey));
    } catch {
      return true;
    }
  }

  #markControlCommandOnce(key, ttlMs = CONTROL_COMMAND_DEDUPE_TTL_MS) {
    const dedupeKey = String(key || "").trim();
    if (!dedupeKey) {
      return true;
    }
    const now = Date.now();
    const existingExpiresAt = this.recentControlCommandByKey.get(dedupeKey) || 0;
    if (existingExpiresAt > now) {
      return false;
    }
    this.recentControlCommandByKey.set(dedupeKey, now + ttlMs);
    if (this.recentControlCommandByKey.size > 200) {
      for (const [entryKey, expiresAt] of this.recentControlCommandByKey) {
        if (expiresAt <= now || this.recentControlCommandByKey.size > 200) {
          this.recentControlCommandByKey.delete(entryKey);
        }
      }
    }
    return true;
  }

  #clearControlCommandMark(key) {
    const dedupeKey = String(key || "").trim();
    if (dedupeKey) {
      this.recentControlCommandByKey.delete(dedupeKey);
    }
  }

  async #handleAgentDelta(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const delta = detectDelta(params);
    if (!delta) {
      return;
    }

    let bKey = null;
    if (turnId) {
      if (this.suppressedTurnIds.has(String(turnId))) {
        return;
      }
      bKey = this.turnToBinding.get(turnId);
    } else {
      bKey = this.threadToBinding.get(threadId);
    }
    if (!bKey) {
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter) {
      return;
    }

    if (adapter.channel === "discord") {
      const discordState = this.#discordTurnState(turnId);
      if (discordState?.presentationEnabled && this.outputPolicy.discord.useLiveEdits) {
        discordState.assistantFullText += String(delta || "");
        discordState.currentAssistantSegmentText += String(delta || "");
        discordState.pendingBoundary = false;
        return;
      }
      const sectionUpdate = this.#turnOutputAppendDelta(threadId, turnId, bKey, delta);
      if (sectionUpdate.sectionText) {
        await this.#sendLongMessage(
          adapter,
          this.#runtimeContext(channel, chatId, threadId, turnId),
          sectionUpdate.sectionText,
          {
            maxLen: this.outputPolicy.liveSectionMaxLen,
            delayMs: this.outputPolicy.liveSectionDelayMs,
          }
        );
      }
    } else {
      await this.#sendStreamingDelta(adapter, { channel, chatId, threadId, turnId }, delta);
    }
  }

  #handleTurnStarted(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const bKey = this.threadToBinding.get(threadId);
    if (bKey && turnId) {
      this.turnToBinding.set(turnId, bKey);
      this.activeTurnByBinding.set(bKey, turnId);
      this.#ensureDiscordTurnState({
        bindingKeyValue: bKey,
        threadId,
        turnId,
      });
      const [channel, chatId] = bKey.split(":");
      const binding = this.store.getBinding(channel, chatId);
      this.autopilotSupervisor?.onTurnStarted({ threadId, turnId }, binding);
    }
  }

  #handleFileChangeOutputDelta(params) {
    const itemId = String(params?.itemId || params?.item?.id || "").trim();
    if (!itemId) {
      return;
    }
    const delta = detectDelta(params) || params?.outputDelta || "";
    if (!delta) {
      return;
    }
    const existing = String(this.fileChangeOutputByItemId.get(itemId) || "");
    this.fileChangeOutputByItemId.set(itemId, trimToLimit(`${existing}${String(delta)}`));
    if (this.fileChangeOutputByItemId.size > 2000) {
      const oldest = this.fileChangeOutputByItemId.keys().next().value;
      if (oldest) {
        this.fileChangeOutputByItemId.delete(oldest);
      }
    }
  }

  async #handleCommandExecutionOutputDelta(params) {
    const itemId = String(params?.itemId || params?.item?.id || "").trim();
    if (!itemId) {
      return;
    }
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (!turnId || this.suppressedTurnIds.has(String(turnId))) {
      return;
    }
    const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter || adapter.channel !== "discord" || !this.#discordTurnState(turnId)?.presentationEnabled) {
      return;
    }
    await this.#sendDiscordCommandOutput(
      adapter,
      channel,
      chatId,
      threadId,
      turnId,
      itemId,
      detectDelta(params) || params?.outputDelta || ""
    );
  }

  async #handleItemStarted(params) {
    const item = params?.item || {};
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (!turnId || this.suppressedTurnIds.has(String(turnId))) {
      return;
    }
    const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter || adapter.channel !== "discord" || !this.#discordTurnState(turnId)?.presentationEnabled) {
      return;
    }
    const state = this.#discordTurnState(turnId);
    if (state) {
      state.pendingBoundary = true;
      state.currentAssistantSegmentText = "";
    }

    if (item?.type === "plan") {
      return;
    }

    await this.#sendDiscordToolActivity(adapter, channel, chatId, threadId, turnId, item);
  }

  async #handlePlanDelta(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (!turnId || this.suppressedTurnIds.has(String(turnId))) {
      return;
    }
    const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter || adapter.channel !== "discord" || !this.#discordTurnState(turnId)?.presentationEnabled) {
      return;
    }
    return;
  }

  async #handleTurnPlanUpdated(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (!turnId || this.suppressedTurnIds.has(String(turnId))) {
      return;
    }
    const bKey = this.turnToBinding.get(turnId) || this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter || adapter.channel !== "discord" || !this.#discordTurnState(turnId)?.presentationEnabled) {
      return;
    }
    const text = summarizePlanUpdate(params);
    if (!text) {
      return;
    }
    await this.#sendDiscordPlanUpdate(adapter, channel, chatId, threadId, turnId, text);
  }

  #handleTurnDiffUpdated(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const key = cacheKeyFromIds(threadId, turnId);
    if (!key) {
      return;
    }
    const diff = String(params?.diff || detectDelta(params) || "").trim();
    if (!diff) {
      return;
    }
    this.latestTurnDiffByKey.set(key, trimToLimit(diff));
    if (this.latestTurnDiffByKey.size > 2000) {
      const oldest = this.latestTurnDiffByKey.keys().next().value;
      if (oldest) {
        this.latestTurnDiffByKey.delete(oldest);
      }
    }
  }

  #handleThreadClosed(params) {
    const threadId = detectThreadId(params) || params?.threadId;
    if (threadId) {
      const bKey = this.threadToBinding.get(threadId);
      this.threadToBinding.delete(threadId);
      if (bKey) {
        for (const [turnId, key] of this.turnToBinding.entries()) {
          if (key === bKey) {
            this.turnToBinding.delete(turnId);
          }
        }
        this.activeTurnByBinding.delete(bKey);
        this.#turnOutputClearByBinding(bKey);
        this.#discordTurnStateClearByBinding(bKey);
        const [channel, chatId] = bKey.split(":");
        const binding = this.store.getBinding(channel, chatId);
        this.#clearThreadAutoApproveForThread(binding, threadId);
        this.#clearThreadPlanModeForThread(binding, threadId);
      }
    }
    this.store.appendAudit({ type: "thread_closed", threadId: threadId || null });
  }

  #handleThreadArchived(params) {
    const threadId = detectThreadId(params) || params?.threadId;
    if (threadId) {
      const bKey = this.threadToBinding.get(threadId);
      this.threadToBinding.delete(threadId);
      if (bKey) {
        this.#turnOutputClearByBinding(bKey);
        this.#discordTurnStateClearByBinding(bKey);
        const [channel, chatId] = bKey.split(":");
        const binding = this.store.getBinding(channel, chatId);
        const updated = this.#clearThreadAutoApproveForThread(binding, threadId);
        const effective = this.#clearThreadPlanModeForThread(updated || binding, threadId) || updated || binding;
        if (effective?.threadId === threadId) {
          this.store.upsertBinding({
            ...effective,
            threadId: null,
          });
        }
      }
    }
    this.store.appendAudit({ type: "thread_archived", threadId: threadId || null });
  }

  async #handleItemCompleted(params) {
    const item = params?.item || {};
    if (item?.type === "plan") {
      const threadId = detectThreadId(params);
      const turnId = detectTurnId(params);
      if (turnId && this.suppressedTurnIds.has(String(turnId))) {
        return;
      }
      const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
      if (!bKey) {
        return;
      }
      const [channel, chatId] = bKey.split(":");
      const adapter = this.#getAdapter(channel);
      if (!adapter) {
        return;
      }
      if (adapter.channel === "discord" && this.#discordTurnState(turnId)?.presentationEnabled && this.outputPolicy.discord.useLiveEdits) {
        return;
      }
      const text = planItemText(item);
      if (!text) {
        return;
      }
      const itemId = String(item?.id || params?.itemId || "").trim();
      const deliveryKey = itemId
        ? `plan:item:${itemId}`
        : `plan:${cacheKeyFromIds(threadId, turnId) || "unknown"}:${shortHash(text)}`;
      if (!this.#markDeliveryOnce(deliveryKey)) {
        return;
      }
      await this.#sendLongMessage(
        adapter,
        adapter.channel === "discord" && this.#discordTurnState(turnId)?.presentationEnabled
          ? this.#discordProgressContext(channel, chatId, threadId, turnId)
          : this.#runtimeContext(channel, chatId, threadId, turnId),
        text,
        {
          maxLen: this.outputPolicy.liveSectionMaxLen,
          delayMs: this.outputPolicy.liveSectionDelayMs,
        }
      );
      return;
    }

    if (item?.type !== "fileChange") {
      return;
    }

    const itemId = String(item?.id || params?.itemId || "").trim();
    if (itemId && this.deliveredFileChangeItemIds.has(itemId)) {
      return;
    }

    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    if (turnId && this.suppressedTurnIds.has(String(turnId))) {
      return;
    }

    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    if (!bKey) {
      return;
    }
    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter) {
      return;
    }

    const cacheKey = cacheKeyFromIds(threadId, turnId);
    const turnDiffText = cacheKey ? String(this.latestTurnDiffByKey.get(cacheKey) || "").trim() : "";
    const toolOutputText = itemId ? String(this.fileChangeOutputByItemId.get(itemId) || "").trim() : "";
    if (itemId) {
      this.fileChangeOutputByItemId.delete(itemId);
    }

    const perItemDiff = fileChangeDiffText(item);
    const preferPerItem = hasWholeFileChanges(item);
    let diffText = "";
    if (preferPerItem && perItemDiff) {
      diffText = perItemDiff;
    } else if (turnDiffText && !this.deliveredTurnDiffByKey.has(cacheKey) && isUnifiedDiffText(turnDiffText)) {
      diffText = formatDiffBlock("Turn diff (aggregated)", turnDiffText);
      this.deliveredTurnDiffByKey.add(cacheKey);
      if (this.deliveredTurnDiffByKey.size > 2000) {
        const oldest = this.deliveredTurnDiffByKey.values().next().value;
        if (oldest) {
          this.deliveredTurnDiffByKey.delete(oldest);
        }
      }
    } else if (perItemDiff) {
      diffText = perItemDiff;
    } else if (toolOutputText && isUnifiedDiffText(toolOutputText)) {
      diffText = formatDiffBlock("Patch diff", toolOutputText);
    }
    if (!diffText) {
      return;
    }

    if (itemId) {
      this.deliveredFileChangeItemIds.add(itemId);
      if (this.deliveredFileChangeItemIds.size > 2000) {
        const oldest = this.deliveredFileChangeItemIds.values().next().value;
        if (oldest) {
          this.deliveredFileChangeItemIds.delete(oldest);
        }
      }
    }

    const deliveryKey = itemId
      ? `file-change:item:${itemId}`
      : `file-change:${cacheKey || "unknown"}:${shortHash(diffText)}`;
    if (!this.#markDeliveryOnce(deliveryKey)) {
      return;
    }

    await this.#sendLongMessageRaw(
      adapter,
      adapter.channel === "discord" && this.#discordTurnState(turnId)?.presentationEnabled
        ? this.#discordProgressContext(channel, chatId, threadId, turnId)
        : this.#runtimeContext(channel, chatId, threadId, turnId),
      diffText,
      {
        maxLen: this.outputPolicy.liveSectionMaxLen,
        delayMs: this.outputPolicy.liveSectionDelayMs,
      }
    );
  }

  async #handleTurnCompleted(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const cacheKey = cacheKeyFromIds(threadId, turnId);
    const hadTurnDiff = Boolean(cacheKey && String(this.latestTurnDiffByKey.get(cacheKey) || "").trim());
    if (cacheKey) {
      this.latestTurnDiffByKey.delete(cacheKey);
      this.deliveredTurnDiffByKey.delete(cacheKey);
    }
    const suppressed = Boolean(turnId && this.suppressedTurnIds.has(String(turnId)));
    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    const finalFromStream = this.#turnOutputTakeFinal(threadId, turnId);
    const discordState = this.#discordTurnState(turnId);
    if (!bKey) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
        this.#clearDiscordTurnState(turnId);
      }
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    const binding = this.store.getBinding(channel, chatId);
    const status = normalizeTurnStatus(params?.turn?.status);
    if (adapter?.channel === "discord" && discordState?.presentationEnabled && this.outputPolicy.discord.useLiveEdits) {
      const finalAssistant = String(
        discordState.assistantFullText || allAgentTextFromTurn(params?.turn || {})
      ).trim();
      if (!suppressed) {
        if (discordState.liveMessageId) {
          await this.#editAdapterMessage(
            adapter,
            {
              ...this.#discordProgressContext(channel, chatId, threadId, turnId),
              chatId: discordState.liveMessageChatId || chatId,
              threadId: discordState.liveMessageChatId || threadId || null,
            },
            discordState.liveMessageId,
            `Completed (${status}).`
          );
        }
      }
      if (!suppressed && finalAssistant) {
        const deliveryKey = `turn-final:${cacheKey || "unknown"}:${shortHash(finalAssistant)}`;
        if (this.#markDeliveryOnce(deliveryKey)) {
          await this.#sendLongMessage(
            adapter,
            this.#discordFinalContext(channel, chatId, threadId, turnId),
            finalAssistant,
            {
              maxLen: this.outputPolicy.discord.finalMessageMaxLen,
              delayMs: this.outputPolicy.discord.finalMessageDelayMs,
            }
          );
        }
      } else if (!suppressed && !finalAssistant && discordState.liveMessageId) {
        await this.#editAdapterMessage(
          adapter,
          {
            ...this.#discordProgressContext(channel, chatId, threadId, turnId),
            chatId: discordState.liveMessageChatId || chatId,
            threadId: discordState.liveMessageChatId || threadId || null,
          },
          discordState.liveMessageId,
          `Turn completed (${status}).`
        );
      }
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
        this.turnToBinding.delete(turnId);
        this.#clearDiscordTurnState(turnId);
      }
      this.activeTurnByBinding.delete(bKey);
      return;
    }
    if (adapter && !suppressed) {
      const fullAssistant = String(
        finalFromStream.fullText || allAgentTextFromTurn(params?.turn || {})
      ).trim();
      const pendingAssistant = String(
        finalFromStream.pendingText || ""
      ).trim();
      if (pendingAssistant) {
        const deliveryKey = `turn-final:${cacheKey || "unknown"}:${shortHash(pendingAssistant)}`;
        if (this.#markDeliveryOnce(deliveryKey)) {
          await this.#sendLongMessage(
            adapter,
            this.#runtimeContext(channel, chatId, threadId, turnId),
            pendingAssistant,
            {
              maxLen: this.outputPolicy.liveSectionMaxLen,
              delayMs: this.outputPolicy.liveSectionDelayMs,
            }
          );
        }
      } else if (!fullAssistant) {
        const completionText = `Turn completed (${status}).`;
        const completionKey = `turn-completed:${cacheKey || "unknown"}:${status}`;
        if (this.#markDeliveryOnce(completionKey)) {
          await this.#sendMessage(adapter, this.#runtimeContext(channel, chatId, threadId, turnId), completionText);
        }
      }
    } else if (adapter && suppressed && adapter.channel === "discord") {
      const partial = String(finalFromStream.pendingText || "").trim();
      if (partial) {
        const partialKey = `turn-suppressed-partial:${cacheKey || "unknown"}:${shortHash(partial)}`;
        if (this.#markDeliveryOnce(partialKey)) {
          await this.#sendLongMessage(adapter, this.#runtimeContext(channel, chatId, threadId, turnId), partial, {
            maxLen: this.outputPolicy.liveSectionMaxLen,
            delayMs: this.outputPolicy.liveSectionDelayMs,
          });
        }
      }
    }
    if (turnId) {
      this.suppressedTurnIds.delete(String(turnId));
      this.#clearDiscordTurnState(turnId);
    }
    this.turnToBinding.delete(turnId);
    this.activeTurnByBinding.delete(bKey);

    if (!suppressed && binding) {
      const finalAssistantText = String(
        (adapter?.channel === "discord"
          ? (discordState?.assistantFullText || "")
          : "") || finalFromStream.fullText || allAgentTextFromTurn(params?.turn || {})
      ).trim();
      const pendingApprovalsCount = this.approvalBroker
        .listPending()
        .filter((record) => (
          String(record.binding?.channel || "") === channel
          && String(record.binding?.chatId || "") === chatId
        ))
        .length;
      const autoResult = await this.autopilotSupervisor?.onTurnCompleted({
        threadId,
        turnId,
        status,
        finalAssistant: finalAssistantText,
        pendingApprovalsCount,
        turnItems: Array.isArray(params?.turn?.items) ? params.turn.items : [],
        hasTurnDiff: hadTurnDiff,
      }, binding);
      if (autoResult?.decision?.action === "continue" && adapter) {
        await this.#sendMessage(
          adapter,
          this.#contextFromBinding(binding),
          formatAutopilotAction(autoResult.decision)
        );
      } else if (
        autopilotConfigForBinding(binding).enabled
        && autopilotConfigForBinding(binding).continueOnTurnComplete
        && autoResult?.decision?.action === "pause"
        && adapter
      ) {
        await this.#sendMessage(
          adapter,
          this.#contextFromBinding(binding),
          formatAutopilotPause(autoResult.decision.reason)
        );
      }
    }
  }

  async #handleRuntimeError(params) {
    const threadId = detectThreadId(params);
    const turnId = detectTurnId(params);
    const cacheKey = cacheKeyFromIds(threadId, turnId);
    const suppressed = Boolean(turnId && this.suppressedTurnIds.has(String(turnId)));
    const bKey = turnId ? this.turnToBinding.get(turnId) : this.threadToBinding.get(threadId);
    const finalFromStream = this.#turnOutputTakeFinal(threadId, turnId);
    const discordState = this.#discordTurnState(turnId);
    if (!bKey) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
        this.#clearDiscordTurnState(turnId);
      }
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const adapter = this.#getAdapter(channel);
    if (!adapter) {
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
        this.#clearDiscordTurnState(turnId);
      }
      return;
    }

    const errorMessage = `Runtime error: ${params?.error?.message || "unknown"}`;
    if (adapter.channel === "discord" && discordState?.presentationEnabled && this.outputPolicy.discord.useLiveEdits) {
      const partial = String(
        discordState.assistantFullText || allAgentTextFromTurn(params?.turn || {})
      ).trim();
      if (discordState.liveMessageId) {
        await this.#editAdapterMessage(
          adapter,
          {
            ...this.#discordProgressContext(channel, chatId, threadId, turnId),
            chatId: discordState.liveMessageChatId || chatId,
            threadId: discordState.liveMessageChatId || threadId || null,
          },
          discordState.liveMessageId,
          "Failed."
        );
      }
      if (partial) {
        const partialKey = `turn-error-partial:${cacheKey || "unknown"}:${shortHash(partial)}`;
        if (this.#markDeliveryOnce(partialKey)) {
          await this.#sendLongMessage(
            adapter,
            this.#discordFinalContext(channel, chatId, threadId, turnId),
            partial,
            {
              maxLen: this.outputPolicy.discord.finalMessageMaxLen,
              delayMs: this.outputPolicy.discord.finalMessageDelayMs,
            }
          );
        }
      }
      if (!suppressed) {
        const errorKey = `turn-error:${cacheKey || "unknown"}:${shortHash(errorMessage)}`;
        if (this.#markDeliveryOnce(errorKey)) {
          await this.#sendMessage(adapter, this.#discordFinalContext(channel, chatId, threadId, turnId), errorMessage);
        }
      }
      if (turnId) {
        this.suppressedTurnIds.delete(String(turnId));
        this.turnToBinding.delete(turnId);
        this.#clearDiscordTurnState(turnId);
      }
      this.activeTurnByBinding.delete(bKey);
      return;
    }
    const partial = String(
      finalFromStream.pendingText || allAgentTextFromTurn(params?.turn || {})
    ).trim();
    if (partial) {
      const partialKey = `turn-error-partial:${cacheKey || "unknown"}:${shortHash(partial)}`;
      if (this.#markDeliveryOnce(partialKey)) {
        await this.#sendLongMessage(adapter, this.#runtimeContext(channel, chatId, threadId, turnId), partial, {
          maxLen: this.outputPolicy.liveSectionMaxLen,
          delayMs: this.outputPolicy.liveSectionDelayMs,
        });
      }
    }
    if (!suppressed) {
      const errorKey = `turn-error:${cacheKey || "unknown"}:${shortHash(errorMessage)}`;
      if (this.#markDeliveryOnce(errorKey)) {
        await this.#sendMessage(adapter, this.#runtimeContext(channel, chatId, threadId, turnId), errorMessage);
      }
    }
    if (turnId) {
      this.suppressedTurnIds.delete(String(turnId));
      this.turnToBinding.delete(turnId);
      this.#clearDiscordTurnState(turnId);
    }
    this.activeTurnByBinding.delete(bKey);
  }

  async #handleInboundSafe(context) {
    try {
      const dedupeKey = inboundDedupeKey(context);
      if (dedupeKey && !this.#markDeliveryOnce(dedupeKey)) {
        this.logger.warn(`duplicate inbound ignored: ${dedupeKey}`);
        return;
      }
      await this.#handleInbound(context);
    } catch (error) {
      const adapter = this.#getAdapter(context.channel);
      if (adapter) {
        await this.#sendMessage(adapter, context, formatRuntimeError(error));
      }
      this.logger.error(`${context.channel} inbound failed`, error);
    }
  }

  async #handleInbound(context) {
    const adapter = this.#getAdapter(context.channel);
    if (!adapter) {
      return;
    }

    const binding = this.#ensureBinding(context);
    const command = parseIncomingCommand(context.text);
    const bKey = bindingKey(binding.channel, binding.chatId);

    this.#appendChatHistory({
      direction: "inbound",
      type: "message",
      channel: context.channel,
      chatId: String(context.chatId),
      userId: context.userId ? String(context.userId) : null,
      userName: context.userName || "",
      text: String(context.text || ""),
      commandType: command.type,
    });

    if (command.type === "empty") {
      return;
    }

    if (command.type === "status") {
      const pending = this.approvalBroker.listPending().length;
      const active = this.activeTurnByBinding.get(bKey);
      const threadScopedAutoApprove = binding.threadId
        ? (this.#threadAutoApproveEnabled(binding, binding.threadId) ? "on" : "off")
        : "n/a";
      const autopilot = autopilotConfigForBinding(binding);
      const autopilotSession = this.autopilotSupervisor?.status(binding);
      await this.#sendMessage(adapter, context, [
        `Binding: ${bKey}`,
        `Thread: ${binding.threadId || "none"}`,
        `Workspace: ${binding.workingDir}`,
        `Model: ${binding.policyProfile?.model || "runtime default"}`,
        `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
        `Fast mode: ${binding.policyProfile?.reasoningEffort === "low" ? "on" : "off"}`,
        `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
        `Autopilot: ${autopilot.enabled ? "on" : "off"} (${autopilot.mode || "rules"})`,
        `Autopilot continue: ${autopilot.continueOnTurnComplete ? "on" : "off"}`,
        `Autopilot auto turns: ${autopilotSession?.automaticTurns || 0}/${autopilot.maxAutomaticTurns || 5}`,
        `Auth mode: inherited from current Codex login state`,
        `Thread auto-approve (command/file): ${threadScopedAutoApprove}`,
        `Active turn: ${active || "none"}`,
        `Pending approvals: ${pending}`,
      ].join("\n"));
      return;
    }

    if (command.type === "help") {
      await this.#sendMessage(adapter, context, commandManual(command.topic));
      return;
    }

    if (!this.#isAuthorized(binding, context)) {
      await this.#sendMessage(
        adapter,
        context,
        "Unauthorized. Your user ID is not in the binding/channel allowlist."
      );
      return;
    }

    const runInterrupt = async () => {
      const turnId = this.activeTurnByBinding.get(bKey);
      if (!binding.threadId || !turnId) {
        await this.#sendMessage(adapter, context, "No active turn to interrupt.");
        return true;
      }
      await this.runtime.interruptTurn({ threadId: binding.threadId, turnId });
      this.suppressedTurnIds.add(String(turnId));
      this.activeTurnByBinding.delete(bKey);
      await this.#sendMessage(adapter, context, `Interrupt requested for turn ${turnId}.`);
      return true;
    };

    const runResume = async (threadId) => {
      if (!threadId) {
        await this.#sendMessage(adapter, context, "Usage: /resume <threadId>");
        return true;
      }
      let resumeResponse = null;
      try {
        resumeResponse = await this.runtime.resumeThread(threadId);
      } catch (error) {
        if (isThreadNotFoundError(error)) {
          await this.#sendMessage(adapter, context, `Thread not found: ${threadId}. Use /new to start a fresh thread.`);
          return true;
        }
        throw error;
      }

      let resumedCwd = extractThreadCwd(resumeResponse);
      if (!resumedCwd) {
        resumedCwd = await this.#resolveThreadCwd(threadId);
      }
      const updated = this.#claimThreadForBinding(binding, threadId, {
        ...(resumedCwd ? { workingDir: resumedCwd } : {}),
      });
      if (resumedCwd) {
        await this.#sendMessage(adapter, context, `Resumed thread: ${threadId}\nWorkspace set to: ${resumedCwd}`);
      } else {
        await this.#sendMessage(adapter, context, `Resumed thread: ${threadId}`);
      }
      await this.#sendThreadHistory(adapter, context, threadId, {
        turns: this.outputPolicy.resumeHistoryTurns,
      });
      Object.assign(binding, updated);
      return true;
    };

    const runAsk = async (prompt, overrides = {}) => {
      if (!prompt) {
        await this.#sendMessage(adapter, context, "Usage: /ask <prompt>");
        return true;
      }
      const started = await this.#startTurnWithRecovery(adapter, context, binding, bKey, prompt, overrides);
      if (!started) {
        return true;
      }
      const { threadId, turnResponse } = started;
      const turnId = turnIdFromResponse(turnResponse);
      if (turnId) {
        this.turnToBinding.set(turnId, bKey);
        this.activeTurnByBinding.set(bKey, turnId);
        if (adapter.channel === "discord") {
          const state = this.#ensureDiscordTurnState({
            bindingKeyValue: bKey,
            threadId,
            turnId,
            inboundContext: context,
          });
          if (state && this.outputPolicy.discord.useLiveEdits) {
            await this.#openDiscordLiveSegment(
              adapter,
              this.#runtimeContext(context.channel, context.chatId, context.threadId || null, turnId),
              state,
              "Working on it...",
              "status"
            );
          }
        }
      }
      if (adapter.channel !== "discord") {
        await this.#sendMessage(adapter, context, `Turn started: ${turnId || "unknown"}`);
      }
      this.store.appendAudit({
        type: "turn_started",
        channel: context.channel,
        chatId: context.chatId,
        threadId,
        turnId,
      });
      return true;
    };

    if (command.type === "new") {
      const controlKey = `control:new:${bKey}`;
      if (!this.#markControlCommandOnce(controlKey)) {
        this.logger.warn(`duplicate control command ignored: ${controlKey}`);
        return;
      }
      try {
        const threadId = await this.#startFreshThreadForBinding(binding, bKey);
        await this.#sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
      } catch (error) {
        this.#clearControlCommandMark(controlKey);
        throw error;
      }
      return;
    }

    if (command.type === "resume") {
      await runResume(command.threadId);
      return;
    }

    if (command.type === "interrupt") {
      await runInterrupt();
      return;
    }

    if (command.type === "turn") {
      const action = command.action || "";
      const { positional, options } = parseArgsAndOptions(command.args);
      if (action === "ask") {
        let turnCwd = binding.workingDir;
        if (options.cwd) {
          const resolved = resolveWorkspacePath(options.cwd, binding.workingDir);
          if (resolved.error) {
            await this.#sendMessage(adapter, context, resolved.error);
            return;
          }
          turnCwd = resolved.value;
        }
        await runAsk(positional.join(" ").trim(), {
          model: options.model || null,
          effort: options.effort || null,
          collaborationMode: options.mode || null,
          cwd: turnCwd,
        });
        return;
      }
      if (action === "steer") {
        const activeTurnId = this.activeTurnByBinding.get(bKey);
        if (!binding.threadId || !activeTurnId) {
          await this.#sendMessage(adapter, context, "No active turn to steer.");
          return;
        }
        const prompt = positional.join(" ").trim();
        if (!prompt) {
          await this.#sendMessage(adapter, context, "Usage: /turn steer <prompt>");
          return;
        }
        await this.runtime.steerTurn({
          threadId: binding.threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: "text", text: prompt }],
        });
        await this.#sendMessage(adapter, context, `Steer accepted for turn ${activeTurnId}.`);
        return;
      }
      if (action === "interrupt") {
        await runInterrupt();
        return;
      }
      if (action === "review") {
        if (!binding.threadId) {
          await this.#sendMessage(adapter, context, "No active thread. Start one with /new first.");
          return;
        }
        const delivery = options.delivery || (toBoolean(options.detached, false) ? "detached" : "inline");
        const targetKey = String(options.target || positional[0] || "uncommitted").toLowerCase();
        let target = { type: "uncommittedChanges" };
        if (["base", "basebranch"].includes(targetKey)) {
          const branch = options.branch || positional[1];
          if (!branch) {
            await this.#sendMessage(adapter, context, "Usage: /turn review base <branch> [--delivery inline|detached]");
            return;
          }
          target = { type: "baseBranch", branch };
        } else if (targetKey === "commit") {
          const sha = options.sha || positional[1];
          if (!sha) {
            await this.#sendMessage(adapter, context, "Usage: /turn review commit <sha> [title words]");
            return;
          }
          const title = options.title || positional.slice(2).join(" ").trim() || null;
          target = { type: "commit", sha, title };
        } else if (targetKey === "custom") {
          const instructions = (options.instructions || positional.slice(1).join(" ")).trim();
          if (!instructions) {
            await this.#sendMessage(adapter, context, "Usage: /turn review custom <instructions...>");
            return;
          }
          target = { type: "custom", instructions };
        }

        const review = await this.runtime.startReview({
          threadId: binding.threadId,
          delivery,
          target,
        });
        const reviewTurnId = turnIdFromResponse(review);
        const reviewThreadId = review?.reviewThreadId || binding.threadId;
        if (delivery === "detached" && reviewThreadId && reviewThreadId !== binding.threadId) {
          const updated = this.#claimThreadForBinding(binding, reviewThreadId);
          Object.assign(binding, updated);
        } else if (reviewThreadId) {
          this.threadToBinding.set(reviewThreadId, bKey);
        }
        if (reviewTurnId) {
          this.turnToBinding.set(reviewTurnId, bKey);
          this.activeTurnByBinding.set(bKey, reviewTurnId);
          if (adapter.channel === "discord") {
            const state = this.#ensureDiscordTurnState({
              bindingKeyValue: bKey,
              threadId: reviewThreadId,
              turnId: reviewTurnId,
              inboundContext: context,
            });
            if (state && this.outputPolicy.discord.useLiveEdits) {
              await this.#openDiscordLiveSegment(
                adapter,
                this.#runtimeContext(context.channel, context.chatId, context.threadId || null, reviewTurnId),
                state,
                "Working on it...",
                "status"
              );
            }
          }
        }
        await this.#sendMessage(
          adapter,
          context,
          `Review started (${delivery}) on thread ${reviewThreadId}${reviewTurnId ? `, turn ${reviewTurnId}` : ""}.`
        );
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /turn <ask|steer|interrupt|review>");
      return;
    }

    if (command.type === "thread") {
      const action = command.action || "";
      const { positional, options } = parseArgsAndOptions(command.args);

      if (action === "start") {
        const cwdResolved = options.cwd ? resolveWorkspacePath(options.cwd, binding.workingDir) : { value: binding.workingDir };
        if (cwdResolved.error) {
          await this.#sendMessage(adapter, context, cwdResolved.error);
          return;
        }
        const response = await this.runtime.startThread({
          cwd: cwdResolved.value,
          approvalPolicy: binding.policyProfile.approvalMode,
          model: options.model || binding.policyProfile.model || null,
        });
        const threadId = threadIdFromResponse(response);
        if (threadId) {
          const updated = this.#claimThreadForBinding(binding, threadId, {
            workingDir: cwdResolved.value,
          });
          Object.assign(binding, updated);
        }
        await this.#sendMessage(adapter, context, `Started thread: ${threadId || "unknown"}`);
        return;
      }

      if (action === "resume") {
        await runResume(positional[0]);
        return;
      }

      if (action === "list" || action === "more") {
        const requestedLimitRaw = positional.find((item) => /^\d+$/.test(item));
        let requestedLimit = toInt(requestedLimitRaw, 10, 1, 100);
        const useAll = action === "list" && (positional.some((item) => item.toLowerCase() === "all") || toBoolean(options.all, false));
        let archived = toBoolean(options.archived, false);

        let cursor = null;
        let cwdFilter = null;
        if (action === "more") {
          const state = this.#getThreadListState(bKey);
          if (!state?.nextCursor) {
            await this.#sendMessage(adapter, context, "No next page available. Run /thread list first.");
            return;
          }
          cursor = state.nextCursor;
          cwdFilter = state.cwdFilter;
          archived = Boolean(state.archived);
          if (!requestedLimitRaw && Number.isFinite(Number(state.limit))) {
            requestedLimit = toInt(state.limit, 10, 1, 100);
          }
        } else {
          cwdFilter = useAll ? null : (options.cwd || binding.workingDir);
          cursor = options.cursor || null;
        }

        const response = await this.runtime.listThreads({
          cursor,
          limit: requestedLimit,
          archived,
          cwd: cwdFilter,
        });
        const threads = threadListFromResponse(response);
        const nextCursor = nextCursorFromResponse(response);
        this.#setThreadListState(bKey, {
          nextCursor,
          cwdFilter,
          archived,
          limit: requestedLimit,
        });

        if (!threads.length) {
          const suffix = cwdFilter ? ` for workspace: ${cwdFilter}` : "";
          await this.#sendMessage(adapter, context, `No threads found${suffix}.`);
          return;
        }

        const entries = threads.map((thread, index) => {
          const id = extractThreadId(thread) || "unknown";
          const marker = binding.threadId && id === binding.threadId ? " (current)" : "";
          const title = threadDisplayTitle(thread);
          const cwd = extractThreadCwd(thread) || "unknown";
          return `${index + 1}. ${title}\t\t${cwd}\t\t${id}${marker}`;
        });
        const threadListText = [
          "Threads:",
          entries.join("\n"),
          "",
          nextCursor ? "Use /thread more for next page." : "No more pages.",
          "Use /resume <threadId> to switch.",
          "Use typed /thread read|archive|fork commands for additional thread actions.",
        ].join("\n");
        if (adapter.channel === "discord") {
          await this.#sendRichMessage(adapter, context, {
            text: threadListText,
            nativeUi: buildDiscordThreadListNativeUi({
              threads: threads.map((thread) => {
                const id = extractThreadId(thread) || "";
                return {
                  threadId: id,
                  title: threadDisplayTitle(thread),
                  cwd: extractThreadCwd(thread) || "unknown",
                  current: Boolean(binding.threadId && id === binding.threadId),
                };
              }),
              nextCursor,
            }),
          });
          return;
        }
        await this.#sendMessage(adapter, context, threadListText);
        return;
      }

      if (action === "read") {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread read <threadId> [--turns true]");
          return;
        }
        const includeTurns = toBoolean(options.turns, false);
        const read = await this.runtime.readThread({ threadId, includeTurns });
        const thread = read?.thread || {};
        await this.#sendMessage(
          adapter,
          context,
          [
            `Thread: ${thread.id || threadId}`,
            `Title: ${thread.name || threadDisplayTitle(thread)}`,
            `Workspace: ${thread.cwd || "unknown"}`,
            `Status: ${thread?.status?.type || "unknown"}`,
            includeTurns ? `Turns: ${(thread.turns || []).length}` : "Turns: hidden (use --turns true)",
          ].join("\n")
        );
        return;
      }

      if (action === "name") {
        const threadId = binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, "No active thread selected. Resume or start a thread first, then run /thread name <name>.");
          return;
        }
        const name = positional.join(" ").trim();
        if (!name) {
          await this.#sendMessage(adapter, context, "Usage: /thread name <display name>");
          return;
        }
        const response = await this.runtime.setThreadName({ threadId, name });
        const nextName = response?.thread?.name || name;
        await this.#sendMessage(adapter, context, `Thread name set: ${nextName}`);
        return;
      }

      if (action === "fork") {
        const sourceThreadId = positional[0] || binding.threadId;
        if (!sourceThreadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread fork <threadId> [--ephemeral true]");
          return;
        }
        const forked = await this.runtime.forkThread({
          threadId: sourceThreadId,
          ephemeral: toBoolean(options.ephemeral, false),
        });
        const newThreadId = threadIdFromResponse(forked);
        if (newThreadId) {
          this.threadToBinding.set(newThreadId, bKey);
        }
        await this.#sendMessage(adapter, context, `Forked thread: ${newThreadId || "unknown"}`);
        return;
      }

      if (action === "loaded") {
        const loaded = await this.runtime.listLoadedThreads();
        const ids = Array.isArray(loaded?.data)
          ? loaded.data
          : (Array.isArray(loaded?.threadIds) ? loaded.threadIds : []);
        await this.#sendMessage(
          adapter,
          context,
          ids.length ? `Loaded threads:\n${ids.join("\n")}` : "No loaded threads."
        );
        return;
      }

      if (action === "unsubscribe") {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, "Usage: /thread unsubscribe <threadId>");
          return;
        }
        const result = await this.runtime.unsubscribeThread(threadId);
        await this.#sendMessage(adapter, context, `Unsubscribe status: ${result?.status || "ok"} (${threadId})`);
        return;
      }

      if (["archive", "unarchive", "compact", "rollback"].includes(action)) {
        const threadId = positional[0] || binding.threadId;
        if (!threadId) {
          await this.#sendMessage(adapter, context, `Usage: /thread ${action} <threadId> --confirm`);
          return;
        }
        if (riskyThreadActionRequiresConfirm(binding.policyProfile.approvalMode) && !toBoolean(options.confirm, false)) {
          await this.#sendMessage(
            adapter,
            context,
            `Confirmation required by approval mode. Re-run with --confirm.\nExample: /thread ${action} ${threadId} --confirm`
          );
          return;
        }

        if (action === "archive") {
          await this.runtime.archiveThread(threadId);
          const updatedPolicy = this.#clearThreadAutoApproveForThread(binding, threadId);
          if (updatedPolicy) {
            Object.assign(binding, updatedPolicy);
          }
          if (binding.threadId === threadId) {
            const updated = this.store.upsertBinding({ ...binding, threadId: null });
            Object.assign(binding, updated);
          }
          this.threadToBinding.delete(threadId);
          await this.#sendMessage(adapter, context, `Archived thread: ${threadId}`);
          return;
        }
        if (action === "unarchive") {
          await this.runtime.unarchiveThread(threadId);
          await this.#sendMessage(adapter, context, `Unarchived thread: ${threadId}`);
          return;
        }
        if (action === "compact") {
          await this.runtime.compactThread(threadId);
          await this.#sendMessage(adapter, context, `Compaction started for thread: ${threadId}`);
          return;
        }
        if (action === "rollback") {
          const numTurns = toInt(options.turns || positional[1], 1, 1, 100);
          await this.runtime.rollbackThread({ threadId, numTurns });
          await this.#sendMessage(adapter, context, `Rolled back ${numTurns} turn(s) on thread: ${threadId}`);
          return;
        }
      }

      await this.#sendMessage(
        adapter,
        context,
        "Usage: /thread <start|resume|list|more|read|name|fork|loaded|unsubscribe|archive|unarchive|compact|rollback>"
      );
      return;
    }

    if (command.type === "threads") {
      const listCmd = {
        type: "thread",
        action: "list",
        args: [
          ...(command.all ? ["all"] : []),
          String(command.limit || 10),
        ],
      };
      await this.#handleInbound({
        ...context,
        text: `/thread list ${listCmd.args.join(" ")}`,
      });
      return;
    }

    if (command.type === "archive") {
      const threadId = String(command.threadId || binding.threadId || "").trim();
      if (!threadId) {
        await this.#sendMessage(adapter, context, "No thread selected. Use /archive <threadId> or /resume <threadId> first.");
        return;
      }
      await this.#handleInbound({
        ...context,
        text: `/thread archive ${threadId}`,
      });
      return;
    }

    const modelOrSkillsHandled = await handleModelAndSkillsCommand({
      command,
      adapter,
      context,
      binding,
      runtime: this.runtime,
      store: this.store,
      sendMessage: (targetAdapter, targetContext, message) => this.#sendMessage(targetAdapter, targetContext, message),
      sendRichMessage: (targetAdapter, targetContext, payload) => this.#sendRichMessage(targetAdapter, targetContext, payload),
      parseArgsAndOptions,
      resolveWorkspacePath,
      toBoolean,
      toInt,
      modelListFromResponse,
      collaborationModesFromResponse,
      buildDiscordModelPickerNativeUi,
      loadSkillsForCwd: (cwd, options) => this.#loadSkillsForCwd(cwd, options),
      touchSkillsContext: (targetBinding, cwd, skills) => this.#touchSkillsContext(targetBinding, cwd, skills),
      resolveSkillByName: (targetBinding, cwd, name, options) => this.#resolveSkillByName(targetBinding, cwd, name, options),
      runAsk,
      clearSkillCache: (cwd) => this.skillsCacheByCwd.delete(cwd),
    });
    if (modelOrSkillsHandled) {
      return;
    }

    if (command.type === "usage") {
      const rateLimits = await this.runtime.readAccountRateLimits();
      await this.#sendMessage(adapter, context, formatRateLimits(rateLimits));
      return;
    }

    if (command.type === "requirements") {
      const requirements = await this.runtime.readConfigRequirements();
      await this.#sendMessage(adapter, context, formatConfigRequirements(requirements));
      return;
    }

    if (command.type === "fast") {
      const action = String(command.action || "show").toLowerCase();
      if (["show", "status"].includes(action)) {
        const enabled = binding.policyProfile?.reasoningEffort === "low";
        await this.#sendMessage(
          adapter,
          context,
          `Fast mode is ${enabled ? "ON" : "OFF"} for this chat. Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}.`
        );
        return;
      }
      if (["on", "enable", "enabled"].includes(action)) {
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            reasoningEffort: "low",
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, "Fast mode enabled. New turns will use reasoning effort: low.");
        return;
      }
      if (["off", "disable", "disabled"].includes(action)) {
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            reasoningEffort: null,
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, "Fast mode disabled. New turns will use the runtime default effort.");
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /fast <on|off|show>");
      return;
    }

    if (command.type === "goal") {
      const action = String(command.action || "show").toLowerCase();
      const currentThreadId = String(binding.threadId || "").trim();
      if (!currentThreadId) {
        await this.#sendMessage(adapter, context, "No active thread selected. Resume or start a thread first, then run /goal.");
        return;
      }
      if (["show", "status", "get"].includes(action)) {
        const response = await this.runtime.getThreadGoal(currentThreadId);
        const goal = goalFromResponse(response);
        await this.#sendMessage(adapter, context, goal ? `Goal:\n${goal}` : "No goal is set for this thread.");
        return;
      }
      if (action === "set") {
        const goal = String(command.value || "").trim();
        if (!goal) {
          await this.#sendMessage(adapter, context, "Usage: /goal <goal text>");
          return;
        }
        const response = await this.runtime.setThreadGoal({ threadId: currentThreadId, goal });
        await this.#sendMessage(adapter, context, `Goal set:\n${goalFromResponse(response) || goal}`);
        return;
      }
      if (["clear", "unset", "off", "delete"].includes(action)) {
        await this.runtime.clearThreadGoal(currentThreadId);
        await this.#sendMessage(adapter, context, "Goal cleared for this thread.");
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /goal <show|set <goal text>|clear>");
      return;
    }

    if (command.type === "plan") {
      const action = String(command.action || "show").toLowerCase();
      const currentThreadId = String(binding.threadId || "").trim();
      if (["show", "status"].includes(action)) {
        const enabled = this.#threadPlanEnabled(binding, currentThreadId);
        const label = currentThreadId || "(no active thread)";
        await this.#sendMessage(adapter, context, `Plan mode is ${enabled ? "ON" : "OFF"} for ${currentThreadId ? label : "the current chat (no active thread selected)"}.`);
        return;
      }
      if (["on", "enable", "enabled"].includes(action)) {
        if (!currentThreadId) {
          await this.#sendMessage(adapter, context, "No active thread selected. Resume or start a thread first, then run /plan on.");
          return;
        }
        const updated = this.#setThreadPlanMode(binding, currentThreadId, true);
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, `Plan mode enabled for ${currentThreadId}. New turns on this thread will run with mode: plan.`);
        return;
      }
      if (["off", "disable", "disabled"].includes(action)) {
        if (!currentThreadId) {
          await this.#sendMessage(adapter, context, "No active thread selected. Resume or start a thread first, then run /plan off.");
          return;
        }
        const updated = this.#setThreadPlanMode(binding, currentThreadId, false);
        Object.assign(binding, updated);
        await this.#sendMessage(adapter, context, `Plan mode disabled for ${currentThreadId}. New turns on this thread will run with mode: default.`);
        return;
      }
      await this.#sendMessage(adapter, context, "Usage: /plan <on|off|show>");
      return;
    }

    if (command.type === "autopilot") {
      const action = String(command.action || "status").toLowerCase();
      if (["status", "show"].includes(action)) {
        await this.#sendMessage(
          adapter,
          context,
          formatAutopilotStatus(this.autopilotSupervisor?.status(binding), binding)
        );
        return;
      }

      if (["on", "enable", "enabled"].includes(action)) {
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            autopilot: {
              ...autopilotConfigForBinding(binding),
              enabled: true,
            },
          },
        });
        Object.assign(binding, updated);
        this.autopilotSupervisor?.reset(binding);
        await this.#sendMessage(
          adapter,
          context,
          `Autopilot enabled.\n\n${formatAutopilotStatus(this.autopilotSupervisor?.status(binding), binding)}`
        );
        return;
      }

      if (["off", "disable", "disabled"].includes(action)) {
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            autopilot: {
              ...autopilotConfigForBinding(binding),
              enabled: false,
            },
          },
        });
        Object.assign(binding, updated);
        this.autopilotSupervisor?.reset(binding);
        await this.#sendMessage(adapter, context, "Autopilot disabled.");
        return;
      }

      if (action === "continue") {
        const mode = String(command.args?.[0] || "").toLowerCase();
        if (!["on", "off"].includes(mode)) {
          await this.#sendMessage(adapter, context, "Usage: /autopilot continue <on|off>");
          return;
        }
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            autopilot: {
              ...autopilotConfigForBinding(binding),
              continueOnTurnComplete: mode === "on",
            },
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(
          adapter,
          context,
          `Autopilot turn continuation ${mode === "on" ? "enabled" : "disabled"}.`
        );
        return;
      }

      if (action === "mode") {
        const mode = String(command.args?.[0] || "").toLowerCase();
        if (!["conservative", "aggressive"].includes(mode)) {
          await this.#sendMessage(adapter, context, "Usage: /autopilot mode <conservative|aggressive>");
          return;
        }
        const updated = this.store.upsertBinding({
          ...binding,
          policyProfile: {
            ...binding.policyProfile,
            autopilot: {
              ...autopilotConfigForBinding(binding),
              mode,
            },
          },
        });
        Object.assign(binding, updated);
        await this.#sendMessage(
          adapter,
          context,
          `Autopilot mode set to ${mode}.`
        );
        return;
      }

      await this.#sendMessage(adapter, context, "Usage: /autopilot <on|off|status|continue on|continue off|mode conservative|mode aggressive>");
      return;
    }

    if (command.type === "answer") {
      const pending = this.#findPendingToolInputRequest(binding, {
        requestId: command.requestId,
        preferredThreadId: binding.threadId || "",
      });
      if (!pending) {
        await this.#sendMessage(
          adapter,
          context,
          "No pending tool input request found for this chat. Wait for a prompt, or use /approve <requestId> <allow|deny>."
        );
        return;
      }

      const decision = String(command.decision || "allow").toLowerCase() === "deny" ? "deny" : "allow";
      if (decision === "deny") {
        const denied = this.approvalBroker.resolve(pending.localRequestId, {
          decision: "deny",
          payload: "",
          actor: context.userId,
        });
        if (!denied) {
          await this.#sendMessage(adapter, context, `Unknown or expired approval request: ${pending.localRequestId}`);
        }
        return;
      }

      const questions = requestUserInputQuestions(pending.params);
      const payloadInput = String(command.payload || "").trim();
      if (!payloadInput) {
        const sample = questions[0]?.id ? `${questions[0].id}=<answer>` : "questionId=<answer>";
        await this.#sendMessage(
          adapter,
          context,
          [
            "Usage: /answer [requestId] <questionId>=<answer>[;<questionId>=<answer>]",
            "Quick options: /answer [requestId] rec  OR  /answer [requestId] 1 1 1",
            `Example: /answer ${pending.localRequestId} ${sample}`,
            `Or deny: /answer deny ${pending.localRequestId}`,
          ].join("\n")
        );
        return;
      }

      const normalizedPayload = normalizeToolAnswerPayload(payloadInput, questions);
      if (normalizedPayload.error) {
        await this.#sendMessage(
          adapter,
          context,
          [
            `Answer parse error: ${normalizedPayload.error}`,
            "Try: /answer rec  OR  /answer 1 1 1  OR  /answer <requestId> <questionId>=<answer>",
          ].join("\n")
        );
        return;
      }

      const resolved = this.approvalBroker.resolve(pending.localRequestId, {
        decision: "allow",
        payload: normalizedPayload.payload,
        actor: context.userId,
      });
      if (!resolved) {
        await this.#sendMessage(adapter, context, `Unknown or expired approval request: ${pending.localRequestId}`);
      }
      return;
    }

    if (command.type === "approveAuto") {
      const action = String(command.action || "").toLowerCase();
      if (!["on", "off", "show"].includes(action)) {
        await this.#sendMessage(adapter, context, "Usage: /approve auto <on|off|show> [threadId]");
        return;
      }
      const targetThreadId = String(command.threadId || binding.threadId || "").trim();
      if (action === "show") {
        if (!targetThreadId) {
          await this.#sendMessage(
            adapter,
            context,
            "Thread auto-approve (command/file): no active thread. Usage: /approve auto show <threadId>"
          );
          return;
        }
        const enabled = this.#threadAutoApproveEnabled(binding, targetThreadId);
        await this.#sendMessage(
          adapter,
          context,
          `Thread auto-approve (command/file) is ${enabled ? "ON" : "OFF"} for ${targetThreadId}.`
        );
        return;
      }
      if (!targetThreadId) {
        await this.#sendMessage(adapter, context, "No target thread selected. Usage: /approve auto <on|off> <threadId>");
        return;
      }
      const enabled = action === "on";
      const updated = this.#setThreadAutoApprove(binding, targetThreadId, enabled);
      Object.assign(binding, updated);
      await this.#sendMessage(
        adapter,
        context,
        `Thread auto-approve (command/file) ${enabled ? "enabled" : "disabled"} for ${targetThreadId}.`
      );
      return;
    }

    if (command.type === "approve") {
      if (!command.requestId || !["allow", "deny"].includes(command.decision)) {
        await this.#sendMessage(adapter, context, "Usage: /approve <requestId> <allow|deny> [payload] or /approve auto <on|off|show> [threadId]");
        return;
      }

      const resolution = this.approvalBroker.resolve(command.requestId, {
        decision: command.decision,
        payload: command.payload,
        actor: context.userId,
      });

      if (!resolution) {
        await this.#sendMessage(adapter, context, `Unknown or expired approval request: ${command.requestId}`);
      }
      return;
    }

    if (command.type === "cwd") {
      const pathInput = String(command.path || "").trim();
      const browseTargetInput = parseCwdBrowseTarget(pathInput);
      const newTargetInput = parseCwdNewTarget(pathInput);
      if (newTargetInput != null) {
        if (!newTargetInput) {
          await this.#sendMessage(adapter, context, `Usage: /${command.command || "cwd"} new <path>`);
          return;
        }
        const resolved = resolveWorkspacePath(newTargetInput, binding.workingDir);
        if (resolved.error && !resolved.error.startsWith("Directory does not exist:")) {
          await this.#sendMessage(adapter, context, resolved.error);
          return;
        }
        const targetDir = resolved.value || resolved.resolved;
        try {
          fs.mkdirSync(targetDir, { recursive: true });
        } catch (error) {
          await this.#sendMessage(
            adapter,
            context,
            `Unable to create directory: ${targetDir} (${error?.message || String(error)})`
          );
          return;
        }

        const updated = this.store.upsertBinding({
          ...binding,
          workingDir: targetDir,
        });
        await this.#sendMessage(
          adapter,
          context,
          `Workspace created and set to: ${updated.workingDir}`
        );
        return;
      }
      if (!pathInput || browseTargetInput != null) {
        const browseTarget = browseTargetInput != null
          ? resolveWorkspacePath(browseTargetInput, binding.workingDir)
          : { value: binding.workingDir };
        if (browseTarget.error) {
          await this.#sendMessage(adapter, context, browseTarget.error);
          return;
        }
        if (adapter.channel === "discord") {
          const listed = listWorkspaceSubdirectories(browseTarget.value);
          if (listed.error) {
            await this.#sendMessage(adapter, context, listed.error);
            return;
          }
          await this.#sendRichMessage(adapter, context, {
            text: listed.currentDir,
            nativeUi: buildDiscordCwdBrowserNativeUi({
              currentDir: listed.currentDir,
              directories: listed.directories,
            }),
          });
          return;
        }

        await this.#sendMessage(adapter, context, `Workspace: ${browseTarget.value}`);
        return;
      }

      const resolved = resolveWorkspacePath(pathInput, binding.workingDir);
      if (resolved.error) {
        await this.#sendMessage(adapter, context, resolved.error);
        return;
      }

      const updated = this.store.upsertBinding({
        ...binding,
        workingDir: resolved.value,
      });
      await this.#sendMessage(
        adapter,
        context,
        `Workspace set to: ${updated.workingDir}`
      );
      return;
    }

    if (command.type === "files") {
      const { options } = parseArgsAndOptions(command.args);
      const rootDir = decodeCommandValue(options.root64) || binding.workingDir;
      const currentDir = decodeCommandValue(options.dir64) || binding.workingDir;
      const previewPath = decodeCommandValue(options.preview64);

      if (previewPath) {
        const preview = buildFilePreview(previewPath, rootDir);
        if (preview.error) {
          await this.#sendMessage(adapter, context, preview.error);
          return;
        }
        await this.#sendLongMessage(adapter, context, preview.text, {
          maxLen: this.outputPolicy.discord.finalMessageMaxLen,
          delayMs: this.outputPolicy.discord.finalMessageDelayMs,
        });
        return;
      }

      const listed = listWorkspaceEntries(rootDir, currentDir);
      if (listed.error) {
        await this.#sendMessage(adapter, context, listed.error);
        return;
      }

      if (adapter.channel === "discord") {
        await this.#sendRichMessage(adapter, context, {
          text: "",
          nativeUi: buildDiscordFilePickerNativeUi({
            mode: "browser",
            rootDir: listed.rootDir,
            currentDir: listed.currentDir,
            entries: listed.entries,
            canGoUp: listed.canGoUp,
          }),
        });
        return;
      }

      await this.#sendMessage(adapter, context, formatFileListText({
        mode: "browser",
        currentDir: listed.currentDir,
        entries: listed.entries,
      }));
      return;
    }

    if (command.type === "search") {
      const { options } = parseArgsAndOptions(command.args);
      const rootDir = decodeCommandValue(options.root64) || binding.workingDir;
      const previewPath = decodeCommandValue(options.preview64);
      const queryFromOption = decodeCommandValue(options.query64);
      const query = queryFromOption || String(command.pattern || "").trim();

      if (previewPath) {
        const preview = buildFilePreview(previewPath, rootDir);
        if (preview.error) {
          await this.#sendMessage(adapter, context, preview.error);
          return;
        }
        await this.#sendLongMessage(adapter, context, preview.text, {
          maxLen: this.outputPolicy.discord.finalMessageMaxLen,
          delayMs: this.outputPolicy.discord.finalMessageDelayMs,
        });
        return;
      }

      if (!query) {
        await this.#sendMessage(adapter, context, "Usage: /search <file-name-fragment>");
        return;
      }

      const matches = searchWorkspaceFiles(rootDir, query);
      if (adapter.channel === "discord") {
        await this.#sendRichMessage(adapter, context, {
          text: formatFileListText({
            mode: "search",
            query,
            entries: matches,
          }),
          nativeUi: buildDiscordFilePickerNativeUi({
            mode: "search",
            rootDir,
            currentDir: rootDir,
            query,
            entries: matches,
            canGoUp: false,
          }),
        });
        return;
      }

      await this.#sendMessage(adapter, context, formatFileListText({
        mode: "search",
        query,
        entries: matches,
      }));
      return;
    }

    if (command.type === "ask") {
      await runAsk(command.prompt);
      return;
    }

    await this.#sendMessage(
      adapter,
      context,
      "Unknown command. Use /help to see all commands and examples."
    );
  }

  async #handleRuntimeNotification(notification) {
    const { method, params } = notification || {};
    if (!method) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      await this.#handleAgentDelta(params);
      return;
    }

    if (method === "item/started") {
      await this.#handleItemStarted(params);
      return;
    }

    if (method === "turn/started") {
      this.#handleTurnStarted(params);
      return;
    }

    if (method === "item/completed") {
      await this.#handleItemCompleted(params);
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      this.#handleFileChangeOutputDelta(params);
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      await this.#handleCommandExecutionOutputDelta(params);
      return;
    }

    if (method === "item/plan/delta") {
      await this.#handlePlanDelta(params);
      return;
    }

    if (method === "turn/diff/updated") {
      this.#handleTurnDiffUpdated(params);
      return;
    }

    if (method === "turn/plan/updated") {
      await this.#handleTurnPlanUpdated(params);
      return;
    }

    if (method === "turn/completed") {
      await this.#handleTurnCompleted(params);
      return;
    }

    if (method === "thread/started") {
      const threadId = detectThreadId(params);
      if (!threadId) {
        return;
      }
      this.store.appendAudit({ type: "thread_started", threadId });
      return;
    }

    if (method === "thread/status/changed") {
      const threadId = detectThreadId(params) || params?.threadId;
      this.store.appendAudit({
        type: "thread_status_changed",
        threadId: threadId || null,
        status: params?.status?.type || "unknown",
      });
      return;
    }

    if (method === "thread/closed") {
      this.#handleThreadClosed(params);
      return;
    }

    if (method === "thread/archived") {
      this.#handleThreadArchived(params);
      return;
    }

    if (method === "thread/unarchived") {
      const threadId = detectThreadId(params) || params?.threadId;
      this.store.appendAudit({ type: "thread_unarchived", threadId: threadId || null });
      return;
    }

    if (method === "skills/changed") {
      this.skillsCacheByCwd.clear();
      this.store.appendAudit({ type: "skills_changed" });
      return;
    }

    if (method === "error") {
      await this.#handleRuntimeError(params);
    }
  }

  async #handleServerRequest(serverRequest) {
    if (!supportedApprovalMethod(serverRequest.method)) {
      this.logger.warn(`unhandled server request method: ${serverRequest.method}`);
      return;
    }

    const threadId = detectThreadId(serverRequest.params);
    const bKey = threadId ? this.threadToBinding.get(threadId) : null;
    if (!bKey) {
      this.logger.warn(`no binding found for server request on thread ${threadId || "unknown"}`);
      await this.runtime.respondServerRequest(serverRequest.id, { decision: "decline" });
      return;
    }

    const [channel, chatId] = bKey.split(":");
    const binding = this.store.getBinding(channel, chatId);
    const adapter = this.#getAdapter(channel);

    if (!binding || !adapter) {
      await this.runtime.respondServerRequest(serverRequest.id, { decision: "decline" });
      return;
    }

    const threadScopedAutoApprove = (
      threadScopedAutoApproveSupportedMethod(serverRequest.method)
      && this.#threadAutoApproveEnabled(binding, threadId)
    );
    const created = this.approvalBroker.create({
      serverRequest,
      binding,
      autoApprove: Boolean(binding.policyProfile?.autoApprove) || threadScopedAutoApprove,
    });

    if (created.autoResolved) {
      return;
    }

    const autopilot = await this.autopilotSupervisor?.onServerRequest(serverRequest, binding, created.record);
    if (autopilot?.handled) {
      this.store.appendAudit({
        type: "approval_autopilot_resolved",
        localRequestId: created.record.localRequestId,
        method: serverRequest.method,
        action: autopilot.decision?.action || "allow",
        channel,
        chatId,
      });
      return;
    }

    const isToolInputRequest = serverRequest.method === "item/tool/requestUserInput";
    const questions = isToolInputRequest ? requestUserInputQuestions(serverRequest.params) : [];
    const approvalSummary = serverRequest.params?.reason || serverRequest.params?.command || (isToolInputRequest ? "tool input required" : "");

    this.store.createPendingApproval({
      ...created.record,
      summary: approvalSummary || "approval required",
    });

    this.store.appendAudit({
      type: "approval_requested",
      localRequestId: created.record.localRequestId,
      method: serverRequest.method,
      channel,
      chatId,
    });

    const turnId = detectTurnId(serverRequest.params);

    await this.#sendApprovalPrompt(
      adapter,
      {
        ...this.#runtimeContext(channel, chatId, threadId, turnId),
        userId: binding.userId || "",
      },
      {
        localRequestId: created.record.localRequestId,
        kind: serverRequest.method,
        summary: approvalSummary,
        questions,
      }
    );
  }
}
