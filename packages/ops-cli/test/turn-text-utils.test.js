import test from "node:test";
import assert from "node:assert/strict";

import { allAgentTextFromTurn, allUserTextFromTurn } from "../src/turn-text-utils.js";

test("turn text utils collect text from content and fallback text fields", () => {
  const turn = {
    items: [
      { type: "userMessage", content: [{ type: "text", text: "user content" }] },
      { type: "userMessage", text: "user fallback" },
      { type: "agentMessage", content: [{ type: "text", text: "agent content" }] },
      { type: "agentMessage", text: "agent fallback" },
    ],
  };

  const user = allUserTextFromTurn(turn);
  const agent = allAgentTextFromTurn(turn);

  assert.equal(user.includes("user content"), true);
  assert.equal(user.includes("user fallback"), true);
  assert.equal(agent.includes("agent content"), true);
  assert.equal(agent.includes("agent fallback"), true);
});
