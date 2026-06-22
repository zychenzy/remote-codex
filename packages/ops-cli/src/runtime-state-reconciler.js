function normalizeThreadId(value) {
  return String(value || "").trim();
}

function loadedThreadIdsFromResponse(response) {
  const raw = response?.data || response?.threadIds || [];
  if (!Array.isArray(raw)) {
    return new Set();
  }
  const ids = raw
    .map((entry) => {
      if (typeof entry === "string") {
        return normalizeThreadId(entry);
      }
      return normalizeThreadId(entry?.threadId || entry?.id);
    })
    .filter(Boolean);
  return new Set(ids);
}

export async function reconcileRuntimeState({
  store,
  runtime,
  logger,
  threadToBinding,
  turnToBinding,
  activeTurnByBinding,
  bindingKeyFn,
  isThreadNotFoundError,
  extractThreadCwd,
  resumeThread = null,
} = {}) {
  turnToBinding.clear();
  activeTurnByBinding.clear();
  threadToBinding.clear();

  const bindings = store.listBindings();
  for (const binding of bindings) {
    const threadId = normalizeThreadId(binding?.threadId);
    if (threadId) {
      threadToBinding.set(threadId, bindingKeyFn(binding.channel, binding.chatId));
    }
  }

  let loadedIds = new Set();
  try {
    const loaded = await runtime.listLoadedThreads({ limit: 500 });
    loadedIds = loadedThreadIdsFromResponse(loaded);
  } catch (error) {
    logger.warn(`failed to query loaded threads during runtime reconciliation: ${error.message}`);
  }

  let clearedBindings = 0;
  let refreshedCwd = 0;
  let verifiedThreads = 0;

  for (const binding of bindings) {
    const threadId = normalizeThreadId(binding?.threadId);
    if (!threadId) {
      continue;
    }

    if (loadedIds.has(threadId)) {
      verifiedThreads += 1;
      continue;
    }

    try {
      const read = await runtime.readThread({ threadId, includeTurns: false });
      if (typeof resumeThread === "function") {
        try {
          await resumeThread(threadId);
        } catch (resumeError) {
          if (isThreadNotFoundError(resumeError)) {
            store.upsertBinding({
              ...binding,
              threadId: null,
            });
            threadToBinding.delete(threadId);
            clearedBindings += 1;
            continue;
          }
          // Non-404 resume failure: the binding is not proven healthy, so do not
          // count it verified or refresh its cwd. Leave it untouched for retry.
          logger.warn(`thread resume failed during runtime reconciliation (${threadId}): ${resumeError.message}`);
          continue;
        }
      }
      verifiedThreads += 1;
      const cwd = extractThreadCwd(read?.thread || read);
      if (cwd && cwd !== binding.workingDir) {
        store.upsertBinding({
          ...binding,
          workingDir: cwd,
        });
        refreshedCwd += 1;
      }
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        store.upsertBinding({
          ...binding,
          threadId: null,
        });
        threadToBinding.delete(threadId);
        clearedBindings += 1;
        continue;
      }

      logger.warn(`thread verification failed during runtime reconciliation (${threadId}): ${error.message}`);
    }
  }

  return {
    loadedCount: loadedIds.size,
    verifiedThreads,
    refreshedCwd,
    clearedBindings,
  };
}

