function oneLine(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(value = "", maxLen = 120) {
  const input = String(value || "").trim();
  if (!input || input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function normalizeToolProgressMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["off", "compact", "verbose"].includes(normalized) ? normalized : "compact";
}

export function summarizeToolActivity(item = {}, { mode = "compact" } = {}) {
  const normalizedMode = normalizeToolProgressMode(mode);
  if (normalizedMode === "off" || !item || typeof item !== "object") {
    return "";
  }

  const type = String(item.type || "").trim();
  const status = String(item.status || "inProgress").trim();

  if (type === "commandExecution") {
    const command = clip(oneLine(item.command || ""), normalizedMode === "verbose" ? 220 : 90);
    const cwd = clip(oneLine(item.cwd || ""), normalizedMode === "verbose" ? 160 : 70);
    const lines = [
      command ? `Terminal: \`${command}\`` : `Terminal ${status === "completed" ? "completed" : "running"}`,
      normalizedMode === "verbose" && cwd ? `Workdir: \`${cwd}\`` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }

  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const preview = changes
      .slice(0, normalizedMode === "verbose" ? 5 : 3)
      .map((change) => {
        const filePath = clip(oneLine(change?.path || "(unknown)"), 80);
        const kind = oneLine(change?.kind || "modified");
        return `- ${filePath} (${kind})`;
      });
    return [
      `File changes proposed (${changes.length || 0})`,
      ...preview,
    ].join("\n");
  }

  if (type === "mcpToolCall") {
    const label = [oneLine(item.server || ""), oneLine(item.tool || "tool")].filter(Boolean).join("/");
    const args = normalizedMode === "verbose" ? clip(oneLine(JSON.stringify(item.arguments || {})), 220) : "";
    return [
      `MCP tool: \`${label || "tool"}\``,
      args ? `Args: ${args}` : "",
    ].filter(Boolean).join("\n");
  }

  if (type === "dynamicToolCall") {
    const label = oneLine(item.tool || "tool");
    const args = normalizedMode === "verbose" ? clip(oneLine(JSON.stringify(item.arguments || {})), 220) : "";
    return [
      `Dynamic tool: \`${label}\``,
      args ? `Args: ${args}` : "",
    ].filter(Boolean).join("\n");
  }

  if (type === "collabToolCall") {
    const tool = oneLine(item.tool || "delegate");
    const prompt = clip(oneLine(item.prompt || ""), normalizedMode === "verbose" ? 180 : 90);
    return [
      `Collab tool: \`${tool}\``,
      prompt ? `Prompt: ${prompt}` : "",
    ].filter(Boolean).join("\n");
  }

  if (type === "imageView") {
    return `Image opened: \`${oneLine(item.path || "") || "image"}\``;
  }

  return "";
}

export function summarizePlanUpdate(params = {}) {
  const explanation = oneLine(params.explanation || "");
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const lines = ["Plan update"];
  if (explanation) {
    lines.push(explanation);
  }
  for (const entry of plan.slice(0, 8)) {
    const status = oneLine(entry?.status || "pending");
    const step = oneLine(entry?.step || "");
    if (!step) {
      continue;
    }
    lines.push(`- [${status}] ${step}`);
  }
  return lines.join("\n");
}
