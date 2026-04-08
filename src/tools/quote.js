import * as telegram from '../lib/telegram';

export const quoteTool = {
	definition: {
		name: "reply_with_quote",
		description: "Reply to a specific quoted portion of the user's message. Use this to address a specific point or question inside a long message.",
		parameters: {
			type: "OBJECT",
			properties: {
				quote: { type: "STRING", description: "The exact text from the user's message you are quoting." },
				reply_text: { type: "STRING", description: "Your response to this specific quote." }
			},
			required: ["quote", "reply_text"]
		}
	},
	async execute(args, env, context) {
		// Pass quote text to reply_parameters via the sendMessage quote parameter
		return await telegram.sendMessage(
			context.chatId,
			context.threadId,
			args.reply_text,
			env,
			context.messageId,
			null,  // markup
			null,  // effectId
			args.quote  // quote text — goes into reply_parameters.quote
		);
	}
};
