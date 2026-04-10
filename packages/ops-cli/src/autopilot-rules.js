function normalizeText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean).join(" ");
  }
  return String(value || "").trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function questionKey(question, index) {
  return String(question?.id || "").trim() || `q${index + 1}`;
}

function sanitizeAnswerValue(value) {
  return String(value || "").replace(/[;\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

function extractQuestions(params = {}) {
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
      const options = safeList(entry.options)
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
      out.push({
        id: String(entry.id || "").trim(),
        question: String(entry.question || entry.prompt || entry.text || "").trim(),
        options,
      });
    }
    if (out.length) {
      return out;
    }
  }
  return [];
}

function action(action, reason, payload = null) {
  return { action, reason, payload };
}

function autopilotConfig(binding) {
  return binding?.policyProfile?.autopilot || {};
}

function allowedWriteRoots(binding) {
  const configured = safeList(autopilotConfig(binding).allowedWriteRoots)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (configured.length) {
    return configured;
  }
  const workingDir = String(binding?.workingDir || "").trim();
  return workingDir ? [workingDir] : [];
}

function isPathWithinRoot(candidatePath, root) {
  const candidate = String(candidatePath || "").trim();
  const normalizedRoot = String(root || "").trim();
  if (!candidate || !normalizedRoot) {
    return false;
  }
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function isWithinAllowedRoots(candidatePath, roots = []) {
  const candidate = String(candidatePath || "").trim();
  if (!candidate) {
    return false;
  }
  return safeList(roots).some((root) => isPathWithinRoot(candidate, root));
}

function dangerousCommand(commandText) {
  const lower = normalizeLowerText(commandText);
  return [
    "git reset --hard",
    "git clean -fd",
    "git checkout --",
    "rm -rf",
  ].some((pattern) => lower.includes(pattern));
}

function commandAllowed(commandText, prefixes = []) {
  const command = normalizeText(commandText);
  if (!command) {
    return false;
  }
  return safeList(prefixes)
    .map((prefix) => String(prefix || "").trim())
    .filter(Boolean)
    .some((prefix) => command === prefix || command.startsWith(prefix));
}

function autopilotMode(binding) {
  return String(autopilotConfig(binding).mode || "conservative").trim().toLowerCase() || "conservative";
}

function itemTypesFromSnapshot(snapshot) {
  const items = safeList(snapshot?.turnItems);
  return items
    .map((item) => String(item?.type || "").trim())
    .filter(Boolean);
}

function completionFingerprint(snapshot) {
  const finalAssistant = normalizeText(snapshot?.finalAssistant || "");
  const itemTypes = itemTypesFromSnapshot(snapshot).join(",");
  const status = String(snapshot?.status || "").trim().toLowerCase();
  return [status, finalAssistant, itemTypes].join("|").trim() || null;
}

function countItems(snapshot, type) {
  return itemTypesFromSnapshot(snapshot).filter((itemType) => itemType === type).length;
}

function hasExecutionProgress(snapshot) {
  return countItems(snapshot, "commandExecution") > 0
    || countItems(snapshot, "fileChange") > 0
    || Boolean(snapshot?.hasTurnDiff);
}

function hasConversationProgress(snapshot, session) {
  const fingerprint = completionFingerprint(snapshot);
  if (!fingerprint) {
    return false;
  }
  return fingerprint !== String(session?.lastCompletionFingerprint || "");
}

function repeatedCompletionCount(snapshot, session) {
  const fingerprint = completionFingerprint(snapshot);
  if (!fingerprint) {
    return Number(session?.repeatedCompletionCount || 0);
  }
  if (fingerprint === String(session?.lastCompletionFingerprint || "")) {
    return Number(session?.repeatedCompletionCount || 0) + 1;
  }
  return 0;
}

function hardStopReason(snapshot, binding, session) {
  const config = autopilotConfig(binding);
  if (String(snapshot?.status || "").trim().toLowerCase() !== "completed") {
    return "turn did not complete successfully";
  }
  if (Number(snapshot?.pendingApprovalsCount || 0) > 0) {
    return "pending approvals still exist";
  }
  if (Number(snapshot?.automaticTurns || 0) >= Number(config.maxAutomaticTurns || 5)) {
    return "automatic turn limit reached";
  }
  if (!normalizeText(snapshot?.finalAssistant || "")) {
    return "assistant output is empty";
  }
  const repeated = repeatedCompletionCount(snapshot, session);
  const repeatLimit = autopilotMode(binding) === "aggressive" ? 2 : 1;
  if (repeated > repeatLimit) {
    return "repeated completion pattern detected";
  }
  return "";
}

export function decideApprovalRequest(serverRequest, binding) {
  const params = serverRequest?.params || {};
  const roots = allowedWriteRoots(binding);
  const method = String(serverRequest?.method || "").trim();

  if (method === "item/commandExecution/requestApproval") {
    if (params?.networkApprovalContext) {
      return action("pause", "network approval requires manual review");
    }
    const commandText = normalizeText(params?.command);
    if (!commandText) {
      return action("pause", "missing command preview");
    }
    if (dangerousCommand(commandText)) {
      return action("pause", "destructive command requires manual review");
    }
    if (!commandAllowed(commandText, autopilotConfig(binding).commandAllowPrefixes)) {
      return action("pause", "command prefix is not allowlisted");
    }
    const cwd = normalizeText(params?.cwd);
    if (!cwd || !isWithinAllowedRoots(cwd, roots)) {
      return action("pause", "command cwd is outside allowed roots");
    }
    return action("allow", "command matches allowlist inside allowed roots");
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = normalizeText(params?.grantRoot);
    if (!grantRoot) {
      return action("pause", "file change grant root missing");
    }
    if (!isWithinAllowedRoots(grantRoot, roots)) {
      return action("pause", "file change is outside allowed roots");
    }
    return action("allow", "file change stays inside allowed roots");
  }

  return action("pause", "unsupported approval request");
}

export function decideToolInputRequest(serverRequest, binding) {
  const strategy = String(autopilotConfig(binding).toolInputStrategy || "recommended_only");
  if (strategy !== "recommended_only") {
    return action("pause", "tool-input strategy is not supported");
  }
  const questions = extractQuestions(serverRequest?.params || {});
  if (!questions.length) {
    return action("pause", "tool input prompt is missing structured questions");
  }
  const pairs = [];
  for (let index = 0; index < questions.length; index += 1) {
    const selected = sanitizeAnswerValue(questions[index]?.options?.[0] || "");
    if (!selected) {
      return action("pause", "tool input options are ambiguous");
    }
    pairs.push(`${questionKey(questions[index], index)}=${selected}`);
  }
  return action("answer", "selected first recommended option for each question", pairs.join(";"));
}

export function decideTurnContinuation(snapshot, binding, session = null) {
  const config = autopilotConfig(binding);
  if (!config.continueOnTurnComplete) {
    return action("pause", "turn continuation is disabled");
  }
  const stopReason = hardStopReason(snapshot, binding, session);
  if (stopReason) {
    return action("pause", stopReason);
  }

  const mode = autopilotMode(binding);
  const executionProgress = hasExecutionProgress(snapshot);
  const conversationProgress = hasConversationProgress(snapshot, session);

  if (mode === "conservative" && !executionProgress) {
    return action("pause", "no concrete execution progress detected in the turn");
  }

  if (!conversationProgress) {
    return action("pause", "completion does not show new progress");
  }

  return action(
    "continue",
    mode === "aggressive"
      ? "hard-stop checks passed in aggressive mode"
      : "execution progress detected in conservative mode",
    "Continue with the next concrete step. Do not ask for confirmation unless required by policy."
  );
}

export function deriveContinuationState(snapshot, session = null) {
  return {
    lastCompletionFingerprint: completionFingerprint(snapshot),
    repeatedCompletionCount: repeatedCompletionCount(snapshot, session),
    hasExecutionProgress: hasExecutionProgress(snapshot),
    hasConversationProgress: hasConversationProgress(snapshot, session),
  };
}
