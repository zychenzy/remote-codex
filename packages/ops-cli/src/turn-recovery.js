export async function startTurnWithRecovery({
  threadId,
  baseParams,
  startTurn,
  resumeThread,
  startFreshThread,
  isThreadNotFoundError,
  onRecovered = async () => {},
  onRecoveredRetryMissing = async () => {},
  onExpired = async () => {},
} = {}) {
  try {
    const turnResponse = await startTurn({ ...baseParams, threadId });
    return { threadId, turnResponse };
  } catch (error) {
    if (!isThreadNotFoundError(error)) {
      throw error;
    }
  }

  let recovered = false;
  try {
    const resumeResponse = await resumeThread(threadId);
    recovered = true;
    await onRecovered({ threadId, resumeResponse });
  } catch (resumeError) {
    if (!isThreadNotFoundError(resumeError)) {
      throw resumeError;
    }
  }

  if (recovered) {
    try {
      const turnResponse = await startTurn({ ...baseParams, threadId });
      return { threadId, turnResponse };
    } catch (retryError) {
      if (!isThreadNotFoundError(retryError)) {
        throw retryError;
      }
      await onRecoveredRetryMissing({ threadId });
    }
  }

  await onExpired({ threadId });
  const freshThreadId = await startFreshThread();
  if (!freshThreadId) {
    return null;
  }
  const turnResponse = await startTurn({ ...baseParams, threadId: freshThreadId });
  return { threadId: freshThreadId, turnResponse };
}
