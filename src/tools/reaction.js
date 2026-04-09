import * as telegram from '../lib/telegram';

export const reactionTool = {
	definition: {
		name: "react_to_message",
		description: "Add an emoji reaction to a message. React contextually and naturally to match the conversation tone. You MUST use ONE of these exact supported emojis: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ⛄ 💅 🤪 🗿 🆒 💘 🙉 🦄 😽 💊 🙊 🕶 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡. Do NOT use any other emoji.",
		parameters: {
			type: "OBJECT",
			properties: {
				emoji: {
					type: "STRING",
					description: "Must be ONE of the exact 73 supported emojis listed above. Choose based on the emotional context of the message."
				},
				react_to_replied: {
					type: "BOOLEAN",
					description: "If true, react to the message the user replied to. Use when the user says 'react to this' while replying."
				}
			},
			required: ["emoji"]
		}
	},
	async execute(args, env, context) {
		const targetId = args.react_to_replied && context.replyToMessageId
			? context.replyToMessageId
			: context.messageId;
		try {
			await telegram.sendReaction(context.chatId, targetId, args.emoji, env);
			return { status: "success" };
		} catch (e) {
			console.error("Reaction failed:", e.message);
			return { status: "error", message: "Unsupported emoji. Use only the 73 listed emojis." };
		}
	}
};
