import * as telegram from '../lib/telegram';

export const pinTool = {
	definition: {
		name: "pin_message",
		description: "Pin a message in the chat. Can pin the user's message (default) or the bot's most recent message if specified.",
		parameters: {
			type: "OBJECT",
			properties: {
				reason: { type: "STRING", description: "Why this message should be pinned" },
				pin_bot_message: { type: "BOOLEAN", description: "If true, pin the bot's last sent message. If false or omitted, pin the user's message." }
			},
			required: ["reason"]
		}
	},
	async execute(args, env, context) {
		const targetId = args.pin_bot_message ? context.lastBotMessageId : context.messageId;
		if (!targetId) {
			return { status: "failed", reason: "No message to pin" };
		}
		const res = await telegram.pinMessage(context.chatId, targetId, env);
		return { status: res?.ok ? "success" : "failed", pinned_message_id: targetId };
	}
};
