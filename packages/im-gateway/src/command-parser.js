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

  if (cmd === "/approve") {
    const requestId = parts[1] || "";
    const decision = (parts[2] || "").toLowerCase();
    const payload = parts.slice(3).join(" ").trim();
    return { type: "approve", requestId, decision, payload };
  }

  if (cmd === "/status") {
    return { type: "status" };
  }

  if (cmd === "/cwd" || cmd === "/workspace") {
    return { type: "cwd", path: trimmed.slice(parts[0].length).trim() };
  }

  return { type: "unknown", raw: trimmed };
}
