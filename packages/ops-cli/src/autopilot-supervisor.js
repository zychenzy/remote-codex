import {
  decideApproval,
  decideToolInput,
  decideTurnContinuationForBinding,
  deriveContinuationStateForBinding,
  shouldHandleWithAutopilot,
} from "./autopilot-policy.js";

function bindingKeyOf(binding) {
  return `${binding.channel}:${binding.chatId}`;
}

export class AutopilotSupervisor {
  constructor({
    store,
    approvalBroker,
    logger = console,
    startFollowupTurn = async () => null,
  } = {}) {
    this.store = store;
    this.approvalBroker = approvalBroker;
    this.logger = logger;
    this.startFollowupTurn = startFollowupTurn;
  }

  onTurnStarted(params, binding) {
    if (!binding) {
      return null;
    }
    const session = this.#currentSession(binding);
    return this.#writeSession(binding, {
      ...session,
      threadId: params?.threadId || session.threadId || binding.threadId || null,
      activeTurnId: params?.turnId || session.activeTurnId || null,
      status: "running_turn",
    });
  }

  async onServerRequest(serverRequest, binding, record) {
    if (!binding || !record || !shouldHandleWithAutopilot(binding)) {
      return { handled: false, decision: null };
    }

    let decision = null;
    if (serverRequest?.method === "item/tool/requestUserInput") {
      decision = decideToolInput(serverRequest, binding);
    } else {
      decision = decideApproval(serverRequest, binding);
    }

    if (!decision || !["allow", "deny", "answer"].includes(decision.action)) {
      return { handled: false, decision };
    }

    const resolution = this.approvalBroker.resolve(record.localRequestId, {
      decision: decision.action === "deny" ? "deny" : "allow",
      payload: decision.action === "answer" ? String(decision.payload || "") : "",
      actor: "autopilot",
    });
    if (!resolution) {
      return { handled: false, decision: null };
    }

    const session = this.#currentSession(binding);
    this.#writeSession(binding, {
      ...session,
      threadId: serverRequest?.params?.threadId || session.threadId || binding.threadId || null,
      activeTurnId: serverRequest?.params?.turnId || session.activeTurnId || null,
      status: serverRequest?.method === "item/tool/requestUserInput"
        ? "waiting_tool_input_decision"
        : "waiting_approval_decision",
      lastAction: {
        type: decision.action,
        reason: decision.reason,
      },
    });
    return { handled: true, decision };
  }

  async onTurnCompleted(snapshot, binding) {
    if (!binding) {
      return { handled: false, decision: null };
    }

    const session = this.#currentSession(binding);
    const baseSession = this.#writeSession(binding, {
      ...session,
      threadId: snapshot?.threadId || session.threadId || binding.threadId || null,
      activeTurnId: null,
      status: "idle",
    });
    const continuationState = deriveContinuationStateForBinding(snapshot, baseSession);

    if (!shouldHandleWithAutopilot(binding)) {
      return { handled: false, decision: null };
    }

    const decision = decideTurnContinuationForBinding({
      ...snapshot,
      automaticTurns: baseSession?.automaticTurns || 0,
    }, binding, baseSession);
    if (!decision || decision.action !== "continue") {
      const nextPauses = Number(baseSession?.consecutivePauses || 0) + 1;
      this.#writeSession(binding, {
        ...baseSession,
        consecutivePauses: nextPauses,
        lastCompletionFingerprint: continuationState.lastCompletionFingerprint,
        repeatedCompletionCount: continuationState.repeatedCompletionCount,
        lastAction: decision ? { type: decision.action, reason: decision.reason } : null,
      });
      return { handled: false, decision };
    }

    try {
      await this.startFollowupTurn(binding, String(decision.payload || ""));
      this.#writeSession(binding, {
        ...baseSession,
        automaticTurns: Number(baseSession?.automaticTurns || 0) + 1,
        consecutivePauses: 0,
        status: "waiting_followup_decision",
        lastCompletionFingerprint: continuationState.lastCompletionFingerprint,
        repeatedCompletionCount: continuationState.repeatedCompletionCount,
        lastAction: {
          type: "continue",
          reason: decision.reason,
        },
      });
      return { handled: true, decision };
    } catch (error) {
      this.logger.warn?.(`autopilot follow-up failed: ${error.message}`);
      this.#writeSession(binding, {
        ...baseSession,
        consecutivePauses: Number(baseSession?.consecutivePauses || 0) + 1,
        status: "paused",
        lastCompletionFingerprint: continuationState.lastCompletionFingerprint,
        repeatedCompletionCount: continuationState.repeatedCompletionCount,
        lastAction: {
          type: "pause",
          reason: error.message,
        },
      });
      return { handled: false, decision: { action: "pause", reason: error.message, payload: null } };
    }
  }

  reset(binding) {
    if (!binding) {
      return;
    }
    this.store.deleteAutopilotSession(bindingKeyOf(binding));
  }

  status(binding) {
    return this.#currentSession(binding);
  }

  #currentSession(binding) {
    return this.store.getAutopilotSession(bindingKeyOf(binding)) || {
      bindingKey: bindingKeyOf(binding),
      threadId: binding.threadId || null,
      activeTurnId: null,
      status: "idle",
      automaticTurns: 0,
      consecutivePauses: 0,
      lastCompletionFingerprint: null,
      repeatedCompletionCount: 0,
      lastAction: null,
    };
  }

  #writeSession(binding, session) {
    return this.store.upsertAutopilotSession({
      ...session,
      bindingKey: bindingKeyOf(binding),
    });
  }
}
