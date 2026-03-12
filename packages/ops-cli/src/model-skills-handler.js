export async function handleModelAndSkillsCommand({
  command,
  adapter,
  context,
  binding,
  runtime,
  store,
  sendMessage,
  parseArgsAndOptions,
  resolveWorkspacePath,
  toBoolean,
  toInt,
  modelListFromResponse,
  collaborationModesFromResponse,
  loadSkillsForCwd,
  touchSkillsContext,
  resolveSkillByName,
  runAsk,
  clearSkillCache,
} = {}) {
  if (command.type === "modelNs") {
    const { positional } = parseArgsAndOptions(command.args);
    if (command.action === "show") {
      await sendMessage(adapter, context, [
        `Model: ${binding.policyProfile?.model || "runtime default"}`,
        `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
        `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
      ].join("\n"));
      return true;
    }
    if (command.action === "list") {
      const response = await runtime.listModels({ includeHidden: false, limit: 30 });
      const models = modelListFromResponse(response);
      if (!models.length) {
        await sendMessage(adapter, context, "No models returned by runtime.");
        return true;
      }
      const lines = models.map((item) => {
        const efforts = (item.supportedReasoningEfforts || [])
          .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
          .filter(Boolean)
          .join(",");
        const hidden = Boolean(item.hidden ?? item.isHidden);
        return `${item.model || item.id}${item.isDefault ? " (default)" : ""}${hidden ? " (hidden)" : ""}${efforts ? ` | efforts:${efforts}` : ""}`;
      });
      await sendMessage(adapter, context, `Models:\n${lines.join("\n")}`);
      return true;
    }
    if (command.action === "set") {
      const nextModelRaw = String(positional[0] || "").trim();
      if (!nextModelRaw) {
        await sendMessage(adapter, context, "Usage: /model set <modelId|default>");
        return true;
      }
      const nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
      const updated = store.upsertBinding({
        ...binding,
        policyProfile: {
          ...binding.policyProfile,
          model: nextModel,
        },
      });
      Object.assign(binding, updated);
      await sendMessage(adapter, context, `Model set to: ${updated.policyProfile?.model || "runtime default"}`);
      return true;
    }
    if (command.action === "effort") {
      const mode = String(positional[0] || "show").toLowerCase();
      if (["show", "get"].includes(mode)) {
        await sendMessage(adapter, context, `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`);
        return true;
      }
      if (mode !== "set" || !positional[1]) {
        await sendMessage(adapter, context, "Usage: /model effort set <low|medium|high|xhigh|default>");
        return true;
      }
      const raw = String(positional[1]).trim().toLowerCase();
      const effort = ["default", "auto"].includes(raw) ? null : raw;
      const updated = store.upsertBinding({
        ...binding,
        policyProfile: {
          ...binding.policyProfile,
          reasoningEffort: effort,
        },
      });
      Object.assign(binding, updated);
      await sendMessage(adapter, context, `Effort set to: ${updated.policyProfile?.reasoningEffort || "runtime default"}`);
      return true;
    }
    if (command.action === "mode") {
      const mode = String(positional[0] || "show").toLowerCase();
      if (mode === "list") {
        const response = await runtime.listCollaborationModes();
        const modes = collaborationModesFromResponse(response);
        const lines = modes.map((item) => `${item.mode || item.name || "unknown"}${item.model ? ` | model:${item.model}` : ""}`);
        await sendMessage(adapter, context, lines.length ? `Modes:\n${lines.join("\n")}` : "No collaboration modes returned.");
        return true;
      }
      if (["show", "get"].includes(mode)) {
        await sendMessage(adapter, context, `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`);
        return true;
      }
      if (mode !== "set" || !positional[1]) {
        await sendMessage(adapter, context, "Usage: /model mode <list|show|set <mode|default>>");
        return true;
      }
      const raw = String(positional[1]).trim();
      const collaborationMode = ["default", "auto"].includes(raw.toLowerCase()) ? null : raw;
      const updated = store.upsertBinding({
        ...binding,
        policyProfile: {
          ...binding.policyProfile,
          collaborationMode,
        },
      });
      Object.assign(binding, updated);
      await sendMessage(adapter, context, `Mode set to: ${updated.policyProfile?.collaborationMode || "runtime default"}`);
      return true;
    }
    await sendMessage(adapter, context, "Usage: /model <show|list|set|effort|mode>");
    return true;
  }

  if (command.type === "skills") {
    const action = command.action || "";
    const { positional, options } = parseArgsAndOptions(command.args);
    const cwdResolved = options.cwd ? resolveWorkspacePath(options.cwd, binding.workingDir) : { value: binding.workingDir };
    if (cwdResolved.error) {
      await sendMessage(adapter, context, cwdResolved.error);
      return true;
    }
    const skillsCwd = cwdResolved.value;

    if (action === "list" || action === "reload") {
      const forceReload = action === "reload" || toBoolean(options.reload, false) || toBoolean(options.forceReload, false);
      const payload = await loadSkillsForCwd(skillsCwd, { forceReload });
      touchSkillsContext(binding, skillsCwd, payload.skills);
      if (!payload.skills.length) {
        await sendMessage(adapter, context, `No skills found for ${skillsCwd}.`);
        return true;
      }
      const limit = toInt(options.limit, 20, 1, 200);
      const lines = payload.skills.slice(0, limit).map((skill) => (
        `${skill.name}${skill.enabled === false ? " (disabled)" : ""} | ${skill.scope || "user"} | ${skill.path || ""}`
      ));
      await sendMessage(adapter, context, `Skills (${skillsCwd}):\n${lines.join("\n")}`);
      return true;
    }

    if (action === "use") {
      const skillName = positional[0];
      const prompt = positional.slice(1).join(" ").trim();
      if (!skillName || !prompt) {
        await sendMessage(adapter, context, "Usage: /skills use <skill-name> <prompt...>");
        return true;
      }
      const skill = await resolveSkillByName(binding, skillsCwd, skillName, { forceReload: false });
      if (!skill?.path) {
        await sendMessage(adapter, context, `Skill not found: ${skillName}. Use /skills list first.`);
        return true;
      }
      const text = prompt.includes(`$${skill.name}`) ? prompt : `$${skill.name} ${prompt}`;
      await runAsk(text, {
        cwd: skillsCwd,
        model: options.model || null,
        effort: options.effort || null,
        collaborationMode: options.mode || null,
        input: [
          { type: "text", text },
          { type: "skill", name: skill.name, path: skill.path },
        ],
      });
      return true;
    }

    if (action === "enable" || action === "disable") {
      const ref = positional[0];
      if (!ref) {
        await sendMessage(adapter, context, "Usage: /skills enable|disable <skill-name-or-path>");
        return true;
      }
      const enabled = action === "enable";
      let skillPath = ref;
      if (!ref.includes("/") && !ref.includes("\\")) {
        const skill = await resolveSkillByName(binding, skillsCwd, ref, { forceReload: false });
        if (!skill?.path) {
          await sendMessage(adapter, context, `Skill not found: ${ref}. Use /skills list first.`);
          return true;
        }
        skillPath = skill.path;
      }
      await runtime.writeSkillConfig({ path: skillPath, enabled });
      clearSkillCache(skillsCwd);
      await sendMessage(adapter, context, `${enabled ? "Enabled" : "Disabled"} skill: ${skillPath}`);
      return true;
    }

    await sendMessage(adapter, context, "Usage: /skills <list|use|enable|disable|reload>");
    return true;
  }

  if (command.type === "model") {
    const nextModelRaw = String(command.value || "").trim();
    if (!nextModelRaw) {
      await sendMessage(adapter, context, `Model: ${binding.policyProfile?.model || "runtime default"}`);
      return true;
    }

    const nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
    const updated = store.upsertBinding({
      ...binding,
      policyProfile: {
        ...binding.policyProfile,
        model: nextModel,
      },
    });
    await sendMessage(adapter, context, `Model set to: ${updated.policyProfile?.model || "runtime default"}`);
    return true;
  }

  return false;
}

