import * as telegram from '../lib/telegram';

export const draftTool = {
	definition: {
		name: "send_draft",
		description: "Pre-fill the user's chat input field with a draft message using Telegram's sendMessageDraft API. Useful for providing templates, suggested replies, or corrections the user can edit before sending.",
		parameters: {
			type: "OBJECT",
			properties: {
				text: { type: "STRING", description: "The text to draft in the user's input field." }
			},
			required: ["text"]
		}
	},
	async execute(args, env, context) {
		await telegram.sendMessageDraft(context.chatId, context.threadId, args.text, env, context.messageId);
		return { status: "success" };
	}
};
