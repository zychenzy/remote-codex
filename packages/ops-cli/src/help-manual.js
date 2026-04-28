function normalizedHelpTopic(topic = "") {
  return String(topic || "").trim().replace(/^\//, "").toLowerCase();
}

export function commandManual(topic = "") {
  const t = normalizedHelpTopic(topic);

  if (!t) {
    return [
      "IM command manual",
      "",
      "/new - start a new thread for this chat binding.",
      "/resume <threadId> - attach to an existing thread.",
      "/ask <prompt> - start a turn with prompt text.",
      "plain text message - same as /ask <text>.",
      "/cwd [path] or /workspace <path> - set or create workspace directory.",
      "/files - browse directories and preview files in the current workspace.",
      "/search <pattern> - recursively search current workspace for files.",
      "/thread ... - thread operations (list/read/fork/archive/unarchive/rollback/compact).",
      "/turn ... - turn operations (ask/steer/interrupt/review).",
      "/model ... - model profile and catalog operations.",
      "/skills ... - list/use/enable/disable/reload skills.",
      "/interrupt or /stop - interrupt active turn.",
      "/threads [limit|all] or /sessions [limit|all] - list threads (current workspace by default).",
      "/archive [threadId] - archive current or specified thread.",
      "/approve <requestId> <allow|deny> [payload] - resolve approval.",
      "/approve auto <on|off|show> [threadId] - thread-scoped auto-approve for command/file requests.",
      "/answer [requestId] <questionId>=<answer>[;<questionId>=<answer>] - reply to tool user-input prompts.",
      "/autopilot <on|off|status|continue on|continue off|mode ...> - unattended helper.",
      "/plan <on|off|show> - quick collaboration mode toggle (plan/default).",
      "/status - show binding/thread/runtime status.",
      "/help [command] - show this help or details for one command.",
      "",
      "Auth/workspace note:",
      "Daemon auth context follows current Codex login; run `reco restart` after changing account/workspace.",
      "",
      "Examples:",
      "/ask summarize this repo",
      "/cwd ~/auto",
      "/files",
      "/search daemon-app",
      "/threads 20",
      "/threads all",
      "/thread list all 20",
      "/turn ask summarize this repo --model gpt-5.4 --effort high",
      "/skills list",
      "/archive",
      "/approve auto on",
      "/autopilot on",
      "/autopilot continue on",
      "/autopilot mode aggressive",
      "/plan on",
      "/answer req-123 mode=fast",
      "/answer rec",
      "/help approve",
    ].join("\n");
  }

  if (t === "new") {
    return [
      "/new",
      "Starts a fresh Codex thread for this binding.",
      "Use when you want a clean context.",
    ].join("\n");
  }

  if (t === "resume") {
    return [
      "/resume <threadId>",
      "Binds this chat to an existing thread id.",
      "Example: /resume 019cdd3b-cdee-7202-ba1b-b0c5713f9fb3",
    ].join("\n");
  }

  if (t === "ask") {
    return [
      "/ask <prompt>",
      "Starts a turn in the current thread; if no thread exists, one is created.",
      "Plain text messages are treated the same as /ask.",
      "Example: /ask implement retry with exponential backoff",
    ].join("\n");
  }

  if (t === "cwd" || t === "workspace") {
    return [
      "/cwd [path]  (alias: /workspace <path>)",
      "Updates this binding workspace directory.",
      "On Discord, bare /cwd opens a subdirectory picker for the current workspace.",
      "Use /cwd browse <dir> to open the same picker at a specific directory without changing the workspace yet.",
      "Use /workspace create <dir> to create a directory and switch to it.",
      "Supports absolute path, relative path, and ~.",
      "Examples: /cwd ~/auto, /cwd /Users/czy/auto, /cwd browse ~/auto/packages, /workspace create ./new-project",
    ].join("\n");
  }

  if (t === "files") {
    return [
      "/files",
      "Browses the current workspace on this binding.",
      "On Discord, selecting a directory enters it immediately; selecting a file enables Preview.",
    ].join("\n");
  }

  if (t === "search") {
    return [
      "/search <pattern>",
      "Recursively searches the current workspace for matching file paths.",
      "On Discord, select a matching file result and use Preview.",
      "Example: /search daemon-app",
    ].join("\n");
  }

  if (t === "interrupt") {
    return [
      "/interrupt  (alias: /stop)",
      "Requests stop for the currently active turn in this chat binding.",
      "If no turn is active, it returns a no-active-turn message.",
    ].join("\n");
  }

  if (t === "threads" || t === "sessions") {
    return [
      "/threads [limit|all]  (alias: /sessions [limit|all])",
      "Lists recent resumable threads from app-server.",
      "Default filters to current binding workspace; use 'all' to disable cwd filter.",
      "Then use /resume <threadId> to switch this chat binding.",
      "Examples: /threads, /threads 20, /threads all, /threads all 30",
    ].join("\n");
  }

  if (t === "thread") {
    return [
      "/thread <start|resume|list|more|read|fork|loaded|unsubscribe|archive|unarchive|compact|rollback>",
      "Native thread controls mapped to app-server thread methods.",
      "Examples:",
      "/thread list 20",
      "/thread list all 50",
      "/thread read <id> --turns true",
      "/thread fork <id> --ephemeral true",
      "/thread archive <id> --confirm",
    ].join("\n");
  }

  if (t === "turn") {
    return [
      "/turn <ask|steer|interrupt|review>",
      "Turn controls with optional per-turn overrides.",
      "Examples:",
      "/turn ask fix lint errors --model gpt-5.4 --effort high --mode default --cwd ~/auto",
      "/turn steer continue and update tests",
      "/turn review --delivery detached --target uncommitted",
    ].join("\n");
  }

  if (t === "archive") {
    return [
      "/archive [threadId]",
      "Archives the current thread for this binding, or a specific thread id.",
      "May require confirmation under current approval policy (use /thread archive <id> --confirm).",
      "Examples: /archive, /archive 019ce1d6-05e7-7c33-9b5b-879d4b90bf2e",
    ].join("\n");
  }

  if (t === "model") {
    return [
      "/model <show|list|set|effort|mode> (legacy: /model <modelId>)",
      "Manage sticky model profile and query model/collaboration catalogs.",
      "Examples:",
      "/model show",
      "/model list",
      "/model set gpt-5.4",
      "/model effort set high",
      "/model mode set default",
    ].join("\n");
  }

  if (t === "skills") {
    return [
      "/skills <list|use|enable|disable|reload>",
      "Explicit skill workflow with app-server skills APIs.",
      "Examples:",
      "/skills list",
      "/skills use skill-creator draft a new skill for release triage",
      "/skills disable /Users/me/.codex/skills/my-skill/SKILL.md",
      "/skills reload",
    ].join("\n");
  }

  if (t === "approve") {
    return [
      "/approve <requestId> <allow|deny> [payload]",
      "/approve auto <on|off|show> [threadId]",
      "Resolves pending command/file/tool approval requests.",
      "Use requestId from the approval prompt message.",
      "Thread auto mode applies only to command/file approvals (tool user-input stays manual).",
      "Examples: /approve req-abc allow, /approve req-abc deny, /approve auto on",
      "For user-input requests, optional payload can be sent after allow/deny.",
    ].join("\n");
  }

  if (t === "answer") {
    return [
      "/answer [requestId] <questionId>=<answer>[;<questionId>=<answer>]",
      "Resolves pending tool user-input prompts from runtime (plan-style follow-up questions).",
      "If requestId is omitted, the latest pending tool prompt for this chat is used.",
      "Quick shortcuts: /answer rec (pick recommended options), /answer 1 1 1 (option numbers by Q order).",
      "Examples: /answer req-abc q1=on;q2=safe, /answer q1=on, /answer deny req-abc",
    ].join("\n");
  }

  if (t === "plan") {
    return [
      "/plan <on|off|show>",
      "Convenience alias for plan mode on the current thread.",
      "on => enable plan mode for current thread, off => disable it, show => inspect current thread state.",
      "Plan mode is OFF by default unless toggled on for a thread.",
      "Examples: /plan on, /plan show, /plan off",
    ].join("\n");
  }

  if (t === "autopilot") {
    return [
      "/autopilot <on|off|status|continue on|continue off|mode conservative|mode aggressive>",
      "Controls the rules-based unattended supervisor for this binding.",
      "on/off toggles autopilot approval and tool-input handling.",
      "continue on/off controls whether autopilot starts a fresh follow-up turn after completion.",
      "mode conservative requires concrete execution progress before continuing.",
      "mode aggressive continues unless a hard stop is detected.",
      "Examples: /autopilot on, /autopilot status, /autopilot continue on, /autopilot mode aggressive",
    ].join("\n");
  }

  if (t === "status") {
    return [
      "/status",
      "Shows binding key, current thread id, workspace path, active turn id, and pending approvals.",
      "Also shows daemon auth mode (inherited from current Codex login state).",
    ].join("\n");
  }

  if (t === "help") {
    return [
      "/help [command]",
      "Shows general command manual or details for one command.",
      "Examples: /help, /help ask, /help approve",
    ].join("\n");
  }

  return [
    `Unknown help topic: ${topic}`,
    "Try /help for full list or /help ask for one command.",
  ].join("\n");
}
