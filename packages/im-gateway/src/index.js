/**
 * ChannelAdapter interface:
 * - sendMessage(context, text)
 * - sendStreamingDelta(context, delta)
 * - sendApprovalPrompt(context, approvalRequest)
 * - registerInboundHandler(handler)
 */
export { BaseAdapter } from "./base-adapter.js";
export { TelegramAdapter } from "./telegram-adapter.js";
export { DiscordAdapter } from "./discord-adapter.js";
export { parseIncomingCommand } from "./command-parser.js";
