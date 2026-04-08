import * as telegram from '../lib/telegram';

export const reactionTool = {
	definition: {
		name: "react_to_message",
		description: "Add an emoji reaction to the user's message. You MUST use one of these exact supported emojis only: 👍 👎 ❤️ 🔥 🎉 👏 💩 🤡 🤯 🌭 💔 🏆 👀 🎃 ☕ ⚡ 🤩 😢 🙏. Using any other emoji will fail.",
		parameters: {
			type: "OBJECT",
			properties: {
				emoji: {
					type: "STRING",
					description: "Must be one of the exact supported emojis listed above."
				}
			},
			required: ["emoji"]
		}
	},
	async execute(args, env, context) {
		try {
			await telegram.sendReaction(context.chatId, context.messageId, args.emoji, env);
			return { status: "success" };
		} catch (e) {
			console.error("Reaction failed:", e.message);
			return { status: "error", message: "Reaction failed — likely unsupported emoji. Use only the listed free emojis." };
		}
	}
};
