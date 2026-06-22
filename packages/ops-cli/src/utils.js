import fs from "node:fs";

export function getArgValue(args, key, fallback = null) {
  const idx = args.indexOf(key);
  if (idx === -1) {
    return fallback;
  }
  const next = args[idx + 1];
  // "flag present, no value": next token is missing or is itself a flag, so do
  // not consume it as this flag's value.
  if (next === undefined || (typeof next === "string" && next.startsWith("-"))) {
    return fallback;
  }
  return next;
}

export function toBoolean(value, fallback = false) {
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

export function splitCsv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function tailFile(filePath, lines = 80) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function detectThreadId(payload) {
  return (
    payload?.threadId ||
    payload?.thread_id ||
    payload?.thread?.id ||
    null
  );
}

export function detectTurnId(payload) {
  return payload?.turnId || payload?.turn_id || payload?.turn?.id || null;
}

export function detectDelta(payload) {
  return payload?.delta || payload?.text || payload?.contentDelta || "";
}

export function resolveBindTargets({ channel, chatIdArg, userIdArg, config }) {
  const channels = config?.channels || {};
  const channelConfig = channels[channel] || {};

  let chatId = chatIdArg || null;
  let userId = userIdArg || null;

  if (channel === "discord" && !chatId) {
    const allowedChannels = channelConfig.allowedChannels || [];
    if (allowedChannels.length === 1) {
      chatId = String(allowedChannels[0]);
    } else if (allowedChannels.length > 1) {
      return {
        error: "Multiple Discord channels are configured. Provide <chatId> or --chat.",
      };
    } else {
      return {
        error: "No Discord channel configured. Re-run setup or pass <chatId>/--chat.",
      };
    }
  }

  if (channel === "discord" && !userId) {
    const allowlist = channelConfig.allowlist || [];
    if (allowlist.length >= 1) {
      userId = String(allowlist[0]);
    }
  }

  if (!chatId) {
    return {
      error: "Missing chatId. Usage: reco bind discord [chatId] [--chat <id>] [--user <id>] [--cwd <dir>]",
    };
  }

  return { chatId: String(chatId), userId: userId ? String(userId) : null };
}
