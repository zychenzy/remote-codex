export function formatAutopilotAction(decision = {}) {
  const action = String(decision?.action || "pause");
  const reason = String(decision?.reason || "").trim();
  if (action === "answer") {
    return `Autopilot answered tool input: ${reason || "rules matched"}.`;
  }
  if (action === "continue") {
    return `Autopilot continued the task: ${reason || "next step detected"}.`;
  }
  if (action === "allow") {
    return `Autopilot approved the request: ${reason || "rules matched"}.`;
  }
  if (action === "deny") {
    return `Autopilot denied the request: ${reason || "rules blocked it"}.`;
  }
  return `Autopilot paused: ${reason || "manual review required"}.`;
}

export function formatAutopilotPause(reason = "") {
  const detail = String(reason || "").trim();
  return detail ? `Autopilot paused: ${detail}.` : "Autopilot paused.";
}

export function formatAutopilotStatus(session = null, binding = null) {
  const config = binding?.policyProfile?.autopilot || {};
  const roots = Array.isArray(config.allowedWriteRoots) && config.allowedWriteRoots.length
    ? config.allowedWriteRoots.join(", ")
    : (binding?.workingDir || "(none)");
  return [
    `Autopilot: ${config.enabled ? "ON" : "OFF"}`,
    `Mode: ${config.mode || "rules"}`,
    `Continue after turn: ${config.continueOnTurnComplete ? "ON" : "OFF"}`,
    `Auto turns used: ${session?.automaticTurns || 0}/${config.maxAutomaticTurns || 5}`,
    `Session status: ${session?.status || "idle"}`,
    `Allowed roots: ${roots}`,
  ].join("\n");
}
