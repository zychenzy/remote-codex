import { EventEmitter } from "node:events";

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
