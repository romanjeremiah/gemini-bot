import * as telegram from '../lib/telegram';

export const pollTool = {
	definition: {
		name: "send_poll",
		description: "Send an interactive poll or quiz to the user. Use for decisions, voting, or knowledge quizzes. For quizzes, set type to 'quiz' and provide correct_option_ids (array of correct answer indices).",
		parameters: {
			type: "OBJECT",
			properties: {
				question: { type: "STRING", description: "The poll question (max 300 characters)" },
				options: { type: "ARRAY", items: { type: "STRING" }, description: "List of options (2 to 10 items)" },
				is_anonymous: { type: "BOOLEAN", description: "Set to false if you want to see who voted. Default true." },
				allows_multiple_answers: { type: "BOOLEAN", description: "True if user can select multiple options" },
				type: { type: "STRING", description: "Poll type: 'regular' (default) or 'quiz'" },
				correct_option_ids: {
					type: "ARRAY",
					items: { type: "INTEGER" },
					description: "For quizzes: array of 0-based indices of the correct option(s). Required when type is 'quiz'."
				},
				explanation: { type: "STRING", description: "For quizzes: text shown when user picks wrong answer (max 200 chars)" }
			},
			required: ["question", "options"]
		}
	},
	async execute(args, env, context) {
		const config = {
			is_anonymous: args.is_anonymous !== false,
			allows_multiple_answers: args.allows_multiple_answers === true
		};
		if (args.type) config.type = args.type;
		// Bot API 9.6: correct_option_ids (array) replaces correct_option_id
		if (args.correct_option_ids) config.correct_option_ids = args.correct_option_ids;
		if (args.explanation) config.explanation = args.explanation;

		await telegram.sendPoll(context.chatId, context.threadId, args.question, args.options, env, config);
		return { status: "success" };
	}
};
