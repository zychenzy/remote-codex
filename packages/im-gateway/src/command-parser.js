const MAX_COMMAND_LENGTH = 8000;

const ANSWER_SHORTHANDS = new Set(["rec", "recommended"]);

// A token is treated as a request id when it is not payload-shaped (=, ;, {),
// not a bare number (numeric option shorthand like "1 2 1"), and not a known
// shorthand keyword. This accepts real non-UUID ids (e.g. req-1) by arity.
function looksLikeRequestId(token = "") {
  const value = String(token || "");
  if (!value) {
    return false;
  }
  if (value.includes("=") || value.includes(";") || value.startsWith("{")) {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return false;
  }
  return !ANSWER_SHORTHANDS.has(value.toLowerCase());
}

export function parseIncomingCommand(text = "") {
  // Strip control bytes and bound length ONCE so every command path (including
  // slice-based /cwd, /search, /ask) inherits sanitized, capped input.
  const trimmed = String(text || "")
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, MAX_COMMAND_LENGTH);
  if (!trimmed) {
    return { type: "empty" };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "ask", prompt: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/new") {
    return { type: "new" };
  }

  if (cmd === "/resume") {
    return { type: "resume", threadId: parts[1] || "" };
  }

  if (cmd === "/ask") {
    return { type: "ask", prompt: trimmed.slice(4).trim() };
  }

  if (cmd === "/interrupt") {
    return { type: "interrupt" };
  }

  if (cmd === "/stop") {
    return { type: "interrupt" };
  }

  if (cmd === "/threads" || cmd === "/sessions") {
    const args = parts.slice(1).map((value) => String(value || "").trim()).filter(Boolean);
    const all = args.some((value) => value.toLowerCase() === "all" || value === "--all");
    // Only accept plain non-negative integers; reject 1.5/1e3/0x10 etc.
    const numericArg = args.find((value) => /^\d+$/.test(value));
    const parsed = numericArg != null ? Number.parseInt(numericArg, 10) : NaN;
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
    return {
      type: "threads",
      all,
      limit: Math.min(Math.max(limit, 1), 50),
    };
  }

  if (cmd === "/archive") {
    return { type: "archive", threadId: parts[1] || "" };
  }

  if (cmd === "/thread") {
    return {
      type: "thread",
      action: (parts[1] || "").toLowerCase(),
      args: parts.slice(2),
      raw: trimmed,
    };
  }

  if (cmd === "/turn") {
    return {
      type: "turn",
      action: (parts[1] || "").toLowerCase(),
      args: parts.slice(2),
      raw: trimmed,
    };
  }

  if (cmd === "/model") {
    const action = (parts[1] || "").toLowerCase();
    if (action === "list") {
      return { type: "model", value: "" };
    }
    if (["show", "set", "effort", "mode"].includes(action)) {
      return {
        type: "modelNs",
        action,
        args: parts.slice(2),
        raw: trimmed,
      };
    }
    return { type: "model", value: parts.slice(1).join(" ").trim() };
  }

  if (cmd === "/plan") {
    return { type: "plan", action: (parts[1] || "show").toLowerCase() };
  }

  if (cmd === "/fast") {
    return { type: "fast", action: (parts[1] || "show").toLowerCase() };
  }

  if (cmd === "/goal") {
    const action = (parts[1] || "show").toLowerCase();
    const managementActions = new Set(["show", "status", "get", "set", "create", "update", "clear", "unset", "off", "delete"]);
    return {
      type: "goal",
      action: managementActions.has(action) ? action : "set",
      value: managementActions.has(action) ? parts.slice(2).join(" ").trim() : parts.slice(1).join(" ").trim(),
      raw: trimmed,
    };
  }

  if (cmd === "/usage") {
    return { type: "usage" };
  }

  if (cmd === "/requirements") {
    return { type: "requirements" };
  }

  if (cmd === "/answer") {
    const first = parts[1] || "";
    const firstLower = first.toLowerCase();

    if (!first) {
      return { type: "answer", decision: "allow", requestId: "", payload: "" };
    }

    if (["allow", "deny"].includes(firstLower)) {
      const second = parts[2] || "";
      const hasRequestId = Boolean(second) && looksLikeRequestId(second);
      const payload = parts.slice(hasRequestId ? 3 : 2).join(" ").trim();
      return {
        type: "answer",
        decision: firstLower,
        requestId: hasRequestId ? second : "",
        payload,
      };
    }

    if (firstLower === "cancel") {
      return { type: "answer", decision: "deny", requestId: "", payload: "" };
    }

    // Explicit arity, not UUID-shape inference: a leading id token (anything
    // that is not payload-shaped, a bare number, or a known shorthand) followed
    // by a payload routes as <id> <payload...>. Otherwise the whole tail is the
    // payload with an empty requestId. This keeps real non-UUID ids from being
    // mis-routed into the payload.
    if (parts.length > 2 && looksLikeRequestId(first)) {
      return {
        type: "answer",
        decision: "allow",
        requestId: first,
        payload: parts.slice(2).join(" ").trim(),
      };
    }

    return {
      type: "answer",
      decision: "allow",
      requestId: "",
      payload: parts.slice(1).join(" ").trim(),
    };
  }

  if (cmd === "/skills") {
    return {
      type: "skills",
      action: (parts[1] || "").toLowerCase(),
      args: parts.slice(2),
      raw: trimmed,
    };
  }

  if (cmd === "/approve") {
    if ((parts[1] || "").toLowerCase() === "auto") {
      const action = (parts[2] || "").toLowerCase();
      const threadId = parts[3] || "";
      return { type: "approveAuto", action, threadId };
    }
    const requestId = parts[1] || "";
    const decision = (parts[2] || "").toLowerCase();
    const payload = parts.slice(3).join(" ").trim();
    return { type: "approve", requestId, decision, payload };
  }

  if (cmd === "/status") {
    return { type: "status" };
  }

  if (cmd === "/autopilot") {
    return {
      type: "autopilot",
      action: (parts[1] || "status").toLowerCase(),
      args: parts.slice(2),
      raw: trimmed,
    };
  }

  if (cmd === "/help" || cmd === "/?") {
    return { type: "help", topic: (parts[1] || "").trim() };
  }

  if (cmd === "/cwd" || cmd === "/workspace") {
    return { type: "cwd", command: cmd.slice(1), path: trimmed.slice(parts[0].length).trim() };
  }

  if (cmd === "/files") {
    return {
      type: "files",
      args: parts.slice(1),
      raw: trimmed,
    };
  }

  if (cmd === "/search") {
    return {
      type: "search",
      pattern: trimmed.slice(parts[0].length).trim(),
      args: parts.slice(1),
      raw: trimmed,
    };
  }

  return { type: "unknown", raw: trimmed };
}
