function turnOutputKey(threadId, turnId) {
  const tid = String(turnId || "").trim();
  if (tid) {
    return `turn:${tid}`;
  }
  const thid = String(threadId || "").trim();
  if (thid) {
    return `thread:${thid}`;
  }
  return "";
}

function boundaryScan(text, { minChunkChars = 280, after = 0 } = {}) {
  const input = String(text || "").replace(/\r/g, "");
  if (!input) {
    return {
      hardBoundary: 0,
      softBoundary: 0,
      inFence: false,
    };
  }

  let inFence = false;
  let lineStart = 0;
  let lastHardBoundary = 0;
  let lastSafeNewline = 0;

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== "\n") {
      continue;
    }
    const line = input.slice(lineStart, i);
    const trimmed = line.trim();
    const isFenceLine = trimmed.startsWith("```");

    if (isFenceLine) {
      inFence = !inFence;
      if (!inFence) {
        lastHardBoundary = i + 1;
      }
    } else if (!inFence) {
      lastSafeNewline = i + 1;
      if (!trimmed) {
        lastHardBoundary = i + 1;
      }
    }

    lineStart = i + 1;
  }

  if (!inFence && input.length - lastHardBoundary >= minChunkChars && lastSafeNewline > lastHardBoundary) {
    lastHardBoundary = lastSafeNewline;
  }

  let softBoundary = 0;
  if (!inFence) {
    const pendingChars = input.length - after;
    if (pendingChars >= minChunkChars) {
      if (lastSafeNewline > after) {
        softBoundary = lastSafeNewline;
      } else {
        const target = Math.min(input.length, after + minChunkChars + 160);
        let whitespace = input.lastIndexOf(" ", target);
        if (whitespace <= after) {
          whitespace = input.lastIndexOf("\t", target);
        }
        softBoundary = whitespace > after ? whitespace : Math.min(input.length, after + minChunkChars);
      }
    }
  }

  return {
    hardBoundary: Math.min(Math.max(lastHardBoundary, 0), input.length),
    softBoundary: Math.min(Math.max(softBoundary, 0), input.length),
    inFence,
  };
}

export function latestPublishableBoundary(text, { minChunkChars = 280 } = {}) {
  return boundaryScan(text, { minChunkChars }).hardBoundary;
}

export class TurnOutputService {
  constructor({ minChunkChars = 280, softChunkChars = 280 } = {}) {
    this.minChunkChars = minChunkChars;
    this.softChunkChars = softChunkChars;
    this.turnTextByKey = new Map();
  }

  reset() {
    this.turnTextByKey.clear();
  }

  appendDelta(threadId, turnId, bindingKey, delta) {
    const state = this.#getOrCreateTurnTextState(threadId, turnId, bindingKey);
    if (!state || !delta) {
      return { sectionText: "" };
    }

    state.assistantText += String(delta || "");
    const scanned = boundaryScan(state.assistantText, {
      minChunkChars: this.minChunkChars,
      after: state.deliveredUntil,
    });
    let nextBoundary = Math.max(scanned.hardBoundary, state.publishedUntil);

    if (nextBoundary <= state.deliveredUntil) {
      const softScan = boundaryScan(state.assistantText, {
        minChunkChars: this.softChunkChars,
        after: state.deliveredUntil,
      });
      if (!softScan.inFence && softScan.softBoundary > state.deliveredUntil) {
        nextBoundary = softScan.softBoundary;
      }
    }

    if (nextBoundary <= state.deliveredUntil) {
      return { sectionText: "" };
    }

    const sectionText = state.assistantText
      .slice(state.deliveredUntil, nextBoundary)
      .trimEnd();

    state.publishedUntil = nextBoundary;
    if (sectionText) {
      state.deliveredUntil = nextBoundary;
    }

    return { sectionText };
  }

  takeFinal(threadId, turnId) {
    const state = this.#takeTurnTextState(threadId, turnId);
    const fullText = String(state?.assistantText || "");
    const pendingText = String(fullText.slice(state?.deliveredUntil || 0) || "").trimEnd();
    return { fullText, pendingText };
  }

  clearByBinding(bindingKey) {
    if (!bindingKey) {
      return;
    }
    for (const [key, value] of this.turnTextByKey.entries()) {
      if (value?.bindingKey === bindingKey) {
        this.turnTextByKey.delete(key);
      }
    }
  }

  #turnTextKeys(threadId, turnId) {
    const candidates = [turnOutputKey(threadId, turnId)];
    const turnOnly = turnOutputKey("", turnId);
    const threadOnly = turnOutputKey(threadId, "");
    if (turnOnly && !candidates.includes(turnOnly)) {
      candidates.push(turnOnly);
    }
    if (threadOnly && !candidates.includes(threadOnly)) {
      candidates.push(threadOnly);
    }
    return candidates.filter(Boolean);
  }

  #getOrCreateTurnTextState(threadId, turnId, bindingKey) {
    const keys = this.#turnTextKeys(threadId, turnId);
    if (!keys.length) {
      return null;
    }

    for (const key of keys) {
      const existing = this.turnTextByKey.get(key);
      if (!existing) {
        continue;
      }
      existing.bindingKey = bindingKey || existing.bindingKey;
      existing.threadId = String(threadId || existing.threadId || "");
      existing.turnId = String(turnId || existing.turnId || "");
      if (key !== keys[0]) {
        this.turnTextByKey.delete(key);
        this.turnTextByKey.set(keys[0], existing);
      }
      return existing;
    }

    const created = {
      bindingKey,
      threadId: String(threadId || ""),
      turnId: String(turnId || ""),
      assistantText: "",
      publishedUntil: 0,
      deliveredUntil: 0,
    };
    this.turnTextByKey.set(keys[0], created);
    return created;
  }

  #takeTurnTextState(threadId, turnId) {
    const keys = this.#turnTextKeys(threadId, turnId);
    for (const key of keys) {
      const existing = this.turnTextByKey.get(key);
      if (!existing) {
        continue;
      }
      this.turnTextByKey.delete(key);
      return existing;
    }
    return null;
  }
}
