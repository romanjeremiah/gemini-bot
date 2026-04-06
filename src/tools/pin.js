import * as telegram from '../lib/telegram';

export const pinTool = {
	definition: {
		name: "pin_message",
		description: "Pin the bot's most recent message in the chat. Use for important reminders or decisions.",
		parameters: {
			type: "OBJECT",
			properties: {
				reason: { type: "STRING", description: "Why this message should be pinned" }
			},
			required: ["reason"]
		}
	},
	async execute(args, env, context) {
		// context.lastBotMessageId is set by the handler after sending
		if (context.lastBotMessageId) {
			await telegram.pinMessage(context.chatId, context.lastBotMessageId, env);
			return { status: "success" };
		}
		return { status: "failed", reason: "No message to pin yet" };
	}
};
