export function parseIncomingCommand(text = "") {
  const trimmed = String(text || "").trim();
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
    const numericArg = args.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    const limit = Number.isFinite(Number(numericArg)) ? Number(numericArg) : 10;
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
    if (["show", "list", "set", "effort", "mode"].includes(action)) {
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

  if (cmd === "/answer") {
    const first = parts[1] || "";
    const firstLower = first.toLowerCase();
    const firstLooksLikePayload = first.includes("=") || first.includes(";") || first.startsWith("{");

    if (!first) {
      return { type: "answer", decision: "allow", requestId: "", payload: "" };
    }

    if (["allow", "deny"].includes(firstLower)) {
      const second = parts[2] || "";
      const secondLooksLikePayload = second.includes("=") || second.includes(";") || second.startsWith("{");
      const hasRequestId = Boolean(second) && !secondLooksLikePayload;
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

    if (parts.length === 2 && firstLooksLikePayload) {
      return {
        type: "answer",
        decision: "allow",
        requestId: "",
        payload: first,
      };
    }

    return {
      type: "answer",
      decision: "allow",
      requestId: first,
      payload: parts.slice(2).join(" ").trim(),
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

  if (cmd === "/help" || cmd === "/?") {
    return { type: "help", topic: (parts[1] || "").trim() };
  }

  if (cmd === "/cwd" || cmd === "/workspace") {
    return { type: "cwd", path: trimmed.slice(parts[0].length).trim() };
  }

  return { type: "unknown", raw: trimmed };
}
