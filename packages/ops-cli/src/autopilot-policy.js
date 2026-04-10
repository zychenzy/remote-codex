import {
  decideApprovalRequest,
  decideToolInputRequest,
  decideTurnContinuation,
  deriveContinuationState,
} from "./autopilot-rules.js";

function autopilotConfig(binding) {
  return binding?.policyProfile?.autopilot || {};
}

export function shouldHandleWithAutopilot(binding) {
  const config = autopilotConfig(binding);
  return Boolean(config.enabled)
    && ["conservative", "aggressive"].includes(String(config.mode || "").trim().toLowerCase());
}

export function decideApproval(serverRequest, binding) {
  return decideApprovalRequest(serverRequest, binding);
}

export function decideToolInput(serverRequest, binding) {
  return decideToolInputRequest(serverRequest, binding);
}

export function decideTurnContinuationForBinding(snapshot, binding, session = null) {
  return decideTurnContinuation(snapshot, binding, session);
}

export function deriveContinuationStateForBinding(snapshot, session = null) {
  return deriveContinuationState(snapshot, session);
}
