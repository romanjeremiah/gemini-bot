import * as telegram from '../lib/telegram';

export const pollTool = {
	definition: {
		name: "send_poll",
		description: "Send an interactive poll to the user. Use this when asking the user to make a decision, choose between options, or for a quiz.",
		parameters: {
			type: "OBJECT",
			properties: {
				question: { type: "STRING", description: "The poll question (max 300 characters)" },
				options: { type: "ARRAY", items: { type: "STRING" }, description: "List of options (2 to 10 items)" },
				is_anonymous: { type: "BOOLEAN", description: "Set to false if you want to see who voted" },
				allows_multiple_answers: { type: "BOOLEAN", description: "True if user can select multiple options" }
			},
			required: ["question", "options"]
		}
	},
	async execute(args, env, context) {
		await telegram.sendPoll(context.chatId, context.threadId, args.question, args.options, env, {
			is_anonymous: args.is_anonymous !== false,
			allows_multiple_answers: args.allows_multiple_answers === true
		});
		return { status: "success" };
	}
};
