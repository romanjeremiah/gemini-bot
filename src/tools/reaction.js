import * as telegram from '../lib/telegram';

export const reactionTool = {
	definition: {
		name: "react_to_message",
		description: "Add an emoji reaction to a message. By default reacts to the user's current message. If the user is replying to another message and asks to react to 'that' or 'this', react to the replied-to message instead. You MUST use one of these exact supported emojis only: 👍 👎 ❤️ 🔥 🎉 👏 💩 🤡 🤯 🌭 💔 🏆 👀 🎃 ☕ ⚡ 🤩 😢 🙏. Using any other emoji will fail.",
		parameters: {
			type: "OBJECT",
			properties: {
				emoji: {
					type: "STRING",
					description: "Must be one of the exact supported emojis listed above."
				},
				react_to_replied: {
					type: "BOOLEAN",
					description: "If true, react to the message the user replied to (not the user's own message). Use when the user says 'react to this' while replying to another message."
				}
			},
			required: ["emoji"]
		}
	},
	async execute(args, env, context) {
		// Choose which message to react to
		const targetId = args.react_to_replied && context.replyToMessageId
			? context.replyToMessageId
			: context.messageId;

		try {
			await telegram.sendReaction(context.chatId, targetId, args.emoji, env);
			return { status: "success" };
		} catch (e) {
			console.error("Reaction failed:", e.message);
			return { status: "error", message: "Reaction failed — likely unsupported emoji. Use only the listed free emojis." };
		}
	}
};
