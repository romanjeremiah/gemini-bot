import * as telegram from '../lib/telegram';

export const reactionTool = {
	definition: {
		name: "react_to_message",
		description: "Add an emoji reaction to the user's message.",
		parameters: {
			type: "OBJECT",
			properties: {
				emoji: { type: "STRING" }
			},
			required: ["emoji"]
		}
	},
	async execute(args, env, context) {
		await telegram.sendReaction(context.chatId, context.messageId, args.emoji, env);
		return { status: "success" };
	}
};
