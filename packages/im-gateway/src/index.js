/**
 * ChannelAdapter interface:
 * - sendMessage(context, text)
 * - sendMessageRich(context, { text, replyToMessageId?, threadId? }) [optional]
 * - editMessage(context, messageId, text) [optional]
 * - sendStreamingDelta(context, delta)
 * - sendApprovalPrompt(context, approvalRequest)
 * - registerInboundHandler(handler)
 */
export { BaseAdapter } from "./base-adapter.js";
export { DiscordAdapter } from "./discord-adapter.js";
export { parseIncomingCommand } from "./command-parser.js";
