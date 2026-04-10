import test from "node:test";
import assert from "node:assert/strict";

import {
  decideApproval,
  decideToolInput,
  decideTurnContinuationForBinding,
  shouldHandleWithAutopilot,
} from "../src/autopilot-policy.js";

function binding(overrides = {}) {
  const autopilot = {
    enabled: true,
    mode: "conservative",
    continueOnTurnComplete: true,
    maxAutomaticTurns: 5,
    maxConsecutivePauses: 2,
    commandAllowPrefixes: ["npm test", "git status"],
    allowedWriteRoots: ["/Users/czy/auto"],
    toolInputStrategy: "recommended_only",
  };
  return {
    channel: "discord",
    chatId: "chat-1",
    workingDir: "/Users/czy/auto",
    policyProfile: {
      autopilot,
      ...(overrides.policyProfile || {}),
    },
    ...overrides,
    policyProfile: {
      autopilot: {
        ...autopilot,
        ...(overrides.policyProfile?.autopilot || {}),
      },
    },
  };
}

test("autopilot policy enables rules mode only when configured", () => {
  assert.equal(shouldHandleWithAutopilot(binding()), true);
  assert.equal(shouldHandleWithAutopilot(binding({
    policyProfile: {
      autopilot: { enabled: false, mode: "conservative" },
    },
  })), false);
});

test("approval allows safe command inside workspace", () => {
  const decision = decideApproval({
    method: "item/commandExecution/requestApproval",
    params: {
      command: "npm test",
      cwd: "/Users/czy/auto",
    },
  }, binding());
  assert.equal(decision.action, "allow");
});

test("approval pauses network approval", () => {
  const decision = decideApproval({
    method: "item/commandExecution/requestApproval",
    params: {
      command: "curl example.com",
      cwd: "/Users/czy/auto",
      networkApprovalContext: { host: "example.com", protocol: "https" },
    },
  }, binding());
  assert.equal(decision.action, "pause");
});

test("approval pauses destructive command", () => {
  const decision = decideApproval({
    method: "item/commandExecution/requestApproval",
    params: {
      command: "git reset --hard HEAD~1",
      cwd: "/Users/czy/auto",
    },
  }, binding());
  assert.equal(decision.action, "pause");
});

test("tool-input answers first option when structured", () => {
  const decision = decideToolInput({
    method: "item/tool/requestUserInput",
    params: {
      questions: [
        {
          id: "mode",
          question: "Pick one",
          options: [{ label: "fast" }, { label: "safe" }],
        },
      ],
    },
  }, binding());
  assert.equal(decision.action, "answer");
  assert.equal(decision.payload, "mode=fast");
});

test("turn continuation continues only for safe completed turns", () => {
  const decision = decideTurnContinuationForBinding({
    status: "completed",
    finalAssistant: "Updated the failing tests.",
    pendingApprovalsCount: 0,
    automaticTurns: 1,
    turnItems: [
      { type: "commandExecution" },
      { type: "fileChange" },
      { type: "agentMessage" },
    ],
    hasTurnDiff: true,
  }, binding());
  assert.equal(decision.action, "continue");
});

test("turn continuation pauses in conservative mode without concrete execution progress", () => {
  const decision = decideTurnContinuationForBinding({
    status: "completed",
    finalAssistant: "I summarized the current state.",
    pendingApprovalsCount: 0,
    automaticTurns: 1,
    turnItems: [
      { type: "agentMessage" },
    ],
  }, binding());
  assert.equal(decision.action, "pause");
});

test("turn continuation continues in aggressive mode without execution progress", () => {
  const decision = decideTurnContinuationForBinding({
    status: "completed",
    finalAssistant: "I summarized the current state.",
    pendingApprovalsCount: 0,
    automaticTurns: 1,
    turnItems: [
      { type: "agentMessage" },
    ],
  }, binding({
    policyProfile: {
      autopilot: {
        mode: "aggressive",
      },
    },
  }));
  assert.equal(decision.action, "continue");
});

test("turn continuation pauses on repeated completion patterns", () => {
  const decision = decideTurnContinuationForBinding({
    status: "completed",
    finalAssistant: "Updated the failing tests.",
    pendingApprovalsCount: 0,
    automaticTurns: 1,
    turnItems: [
      { type: "commandExecution" },
      { type: "agentMessage" },
    ],
  }, binding(), {
    lastCompletionFingerprint: "completed|Updated the failing tests.|commandExecution,agentMessage",
    repeatedCompletionCount: 1,
  });
  assert.equal(decision.action, "pause");
});
