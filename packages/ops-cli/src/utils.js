import fs from "node:fs";

export function getArgValue(args, key, fallback = null) {
  const idx = args.indexOf(key);
  if (idx === -1) {
    return fallback;
  }
  return args[idx + 1] ?? fallback;
}

export function toBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
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
