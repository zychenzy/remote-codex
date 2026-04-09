import { EventEmitter } from "node:events";

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }
  const out = [];
  for (const entry of rawQuestions) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = String(entry.id || "").trim();
    const question = String(entry.question || entry.prompt || entry.text || "").trim();
    const options = Array.isArray(entry.options) ? entry.options : [];
    out.push({ id, question, options });
  }
  return out;
}

function optionLabel(option) {
  if (option == null) {
    return "";
  }
  if (typeof option === "string") {
    return option.trim();
  }
  if (typeof option === "object") {
    return String(option.label || option.value || option.id || "").trim();
  }
  return "";
}

export class BaseAdapter extends EventEmitter {
  constructor({ channel, logger = console } = {}) {
    super();
    this.channel = channel;
    this.logger = logger;
    this.inboundHandler = null;
    this.streamingBuffers = new Map();
  }

  registerInboundHandler(handler) {
    this.inboundHandler = handler;
  }

  emitInbound(context) {
    if (!this.inboundHandler) {
      return;
    }
    this.inboundHandler(context);
  }

  async sendMessageRich(context, payload = {}) {
    return this.sendMessage(context, payload.text || "");
  }

  async editMessage(_context, _messageId, _text) {
    return null;
  }

  isAuthorized(context, allowlist = []) {
    if (!allowlist || allowlist.length === 0) {
      return false;
    }
    return allowlist.includes(String(context.userId));
  }

  async sendStreamingDelta(context, textDelta) {
    const key = `${context.channel}:${context.chatId}:${context.turnId || "turn"}`;
    const buffer = this.streamingBuffers.get(key) || { value: "", timer: null };
    buffer.value += textDelta;

    if (buffer.timer) {
      this.streamingBuffers.set(key, buffer);
      return;
    }

    buffer.timer = setTimeout(async () => {
      try {
        const content = buffer.value;
        this.streamingBuffers.delete(key);
        if (content.trim()) {
          await this.sendMessage(context, content);
        }
      } catch (error) {
        const message = error?.message || String(error);
        this.logger?.error?.(`[${this.channel || "adapter"}] failed to flush streaming delta: ${message}`);
      }
    }, 900);

    this.streamingBuffers.set(key, buffer);
  }

  async sendApprovalPrompt(context, approvalRequest) {
    if (approvalRequest.kind === "item/tool/requestUserInput") {
      const questions = normalizeQuestions(approvalRequest.questions);
      const lines = [
        `User input required (${approvalRequest.kind})`,
        `requestId: ${approvalRequest.localRequestId}`,
        approvalRequest.summary ? `details: ${approvalRequest.summary}` : "",
      ].filter(Boolean);

      if (questions.length) {
        lines.push("questions:");
        for (let index = 0; index < questions.length; index += 1) {
          const question = questions[index];
          const title = question.question || "(question)";
          const key = question.id ? ` [${question.id}]` : "";
          lines.push(`Q${index + 1}${key} ${title}`);
          const labels = question.options
            .map((option) => optionLabel(option))
            .filter(Boolean);
          if (labels.length) {
            lines.push(`options: ${labels.map((label, optIndex) => `${optIndex + 1}.${label}`).join(" | ")}`);
          }
        }
      }

      lines.push(
        `quick: /answer ${approvalRequest.localRequestId} rec`,
        `quick: /answer ${approvalRequest.localRequestId} 1 1 1  (Q1..Qn option numbers)`,
        `reply: /answer ${approvalRequest.localRequestId} <questionId>=<answer>[;<questionId>=<answer>]`,
        `or:    /answer deny ${approvalRequest.localRequestId}`
      );
      await this.sendMessage(context, lines.join("\n"));
      return;
    }

    const summary = [
      `Approval required (${approvalRequest.kind})`,
      `requestId: ${approvalRequest.localRequestId}`,
      approvalRequest.summary ? `details: ${approvalRequest.summary}` : "",
      `reply: /approve ${approvalRequest.localRequestId} allow`,
      `or:    /approve ${approvalRequest.localRequestId} deny`,
    ].filter(Boolean).join("\n");

    await this.sendMessage(context, summary);
  }
}
