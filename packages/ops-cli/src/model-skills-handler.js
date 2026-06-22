export async function handleModelAndSkillsCommand({
  command,
  adapter,
  context,
  binding,
  runtime,
  store,
  sendMessage,
  sendRichMessage,
  parseArgsAndOptions,
  resolveWorkspacePath,
  toBoolean,
  toInt,
  modelListFromResponse,
  collaborationModesFromResponse,
  buildDiscordModelPickerNativeUi,
  loadSkillsForCwd,
  touchSkillsContext,
  resolveSkillByName,
  runAsk,
  clearSkillCache,
} = {}) {
  if (command.type === "modelNs") {
    const { positional } = parseArgsAndOptions(command.args);
    if (command.action === "show") {
      if (adapter?.channel === "discord" && typeof sendRichMessage === "function" && typeof buildDiscordModelPickerNativeUi === "function") {
        const [modelsResponse, modesResponse] = await Promise.all([
          runtime.listModels({ includeHidden: false, limit: 30 }),
          runtime.listCollaborationModes().catch(() => ({ data: [] })),
        ]);
        await sendRichMessage(adapter, context, {
          text: [
            `Model: ${binding.policyProfile?.model || "runtime default"}`,
            `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
            `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
          ].join("\n"),
          nativeUi: buildDiscordModelPickerNativeUi({
            currentModel: binding.policyProfile?.model || "",
            currentEffort: binding.policyProfile?.reasoningEffort || "",
            currentMode: binding.policyProfile?.collaborationMode || "",
            models: modelListFromResponse(modelsResponse),
            modes: collaborationModesFromResponse(modesResponse),
          }),
        });
        return true;
      }
      await sendMessage(adapter, context, [
        `Model: ${binding.policyProfile?.model || "runtime default"}`,
        `Effort: ${binding.policyProfile?.reasoningEffort || "runtime default"}`,
        `Mode: ${binding.policyProfile?.collaborationMode || "runtime default"}`,
      ].join("\n"));
      return true;
    }
    if (command.action === "set") {
      const nextModelRaw = String(positional[0] || "").trim();
      if (!nextModelRaw) {
        await sendMessage(adapter, context, "Usage: /model set <modelId|default>");
        return true;
      }
      let nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
      if (nextModel) {
        try {
          const resolved = await resolveSelectableModelId({
            runtime,
            modelListFromResponse,
            requestedModel: nextModel,
          });
          if (!resolved.modelId) {
            const listHint = resolved.selectableModelIds.length
              ? `Selectable models: ${resolved.selectableModelIds.slice(0, 20).join(", ")}`
              : "No selectable models returned by runtime.";
            await sendMessage(
              adapter,
              context,
              resolved.foundHidden
                ? `Model is not selectable: ${nextModel}. ${listHint}`
                : `Unknown model: ${nextModel}. ${listHint}`
            );
            return true;
          }
          nextModel = resolved.modelId;
        } catch (error) {
          const detail = error?.message ? ` (${error.message})` : "";
          await sendMessage(adapter, context, `Failed to validate model selection${detail}`);
          return true;
        }
      }
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
      const collaborationMode = ["default", "auto"].includes(raw.toLowerCase()) ? "default" : raw;
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
    await sendMessage(adapter, context, "Usage: /model <show|set|effort|mode>");
    return true;
  }

  if (command.type === "skills") {
    const action = command.action || "";
    const { positional, options } = parseArgsAndOptions(command.args);
    const cwdResolved = options.cwd ? resolveWorkspacePath(options.cwd, binding.workingDir, binding.workspaceRoot ?? binding.workingDir) : { value: binding.workingDir };
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
      if (adapter?.channel === "discord" && typeof sendRichMessage === "function" && typeof buildDiscordModelPickerNativeUi === "function") {
        const [modelsResponse, modesResponse] = await Promise.all([
          runtime.listModels({ includeHidden: false, limit: 30 }),
          runtime.listCollaborationModes().catch(() => ({ data: [] })),
        ]);
        await sendRichMessage(adapter, context, {
          text: `Model: ${binding.policyProfile?.model || "runtime default"}`,
          nativeUi: buildDiscordModelPickerNativeUi({
            currentModel: binding.policyProfile?.model || "",
            currentEffort: binding.policyProfile?.reasoningEffort || "",
            currentMode: binding.policyProfile?.collaborationMode || "",
            models: modelListFromResponse(modelsResponse),
            modes: collaborationModesFromResponse(modesResponse),
          }),
        });
        return true;
      }
      await sendMessage(adapter, context, `Model: ${binding.policyProfile?.model || "runtime default"}`);
      return true;
    }

    let nextModel = ["default", "auto"].includes(nextModelRaw.toLowerCase()) ? null : nextModelRaw;
    if (nextModel) {
      try {
        const resolved = await resolveSelectableModelId({
          runtime,
          modelListFromResponse,
          requestedModel: nextModel,
        });
        if (!resolved.modelId) {
          const listHint = resolved.selectableModelIds.length
            ? `Selectable models: ${resolved.selectableModelIds.slice(0, 20).join(", ")}`
            : "No selectable models returned by runtime.";
          await sendMessage(
            adapter,
            context,
            resolved.foundHidden
              ? `Model is not selectable: ${nextModel}. ${listHint}`
              : `Unknown model: ${nextModel}. ${listHint}`
          );
          return true;
        }
        nextModel = resolved.modelId;
      } catch (error) {
        const detail = error?.message ? ` (${error.message})` : "";
        await sendMessage(adapter, context, `Failed to validate model selection${detail}`);
        return true;
      }
    }
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

  return false;
}

function normalizeRuntimeModels(models = []) {
  const out = [];
  for (const item of Array.isArray(models) ? models : []) {
    const id = String(item?.model || item?.id || "").trim();
    if (!id) {
      continue;
    }
    const hidden = Boolean(item?.hidden ?? item?.isHidden);
    out.push({ id, hidden });
  }
  return out;
}

async function resolveSelectableModelId({
  runtime,
  modelListFromResponse,
  requestedModel,
} = {}) {
  const response = await runtime.listModels({ includeHidden: false, limit: 200 });
  const models = normalizeRuntimeModels(modelListFromResponse(response));
  const selectableModelIds = [];
  let foundHidden = false;

  for (const entry of models) {
    if (!entry.hidden) {
      selectableModelIds.push(entry.id);
    }
    if (entry.id === requestedModel && entry.hidden) {
      foundHidden = true;
    }
    if (entry.id === requestedModel && !entry.hidden) {
      return {
        modelId: entry.id,
        selectableModelIds,
      };
    }
  }

  return {
    modelId: null,
    selectableModelIds,
    foundHidden,
  };
}
