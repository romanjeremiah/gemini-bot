import * as telegram from '../lib/telegram';

export const draftTool = {
	definition: {
		name: "send_draft",
		description: "Provide the user with a pre-filled message they can tap to share or send. Opens a share dialog with the text already filled in. Useful for providing templates, suggested replies, or messages the user can forward.",
		parameters: {
			type: "OBJECT",
			properties: {
				text: { type: "STRING", description: "The text to pre-fill for the user." }
			},
			required: ["text"]
		}
	},
	async execute(args, env, context) {
		// Use Telegram's deep link share URL — tapping the button opens
		// a chat picker with the text pre-filled in the input field
		const shareUrl = `https://t.me/share/url?text=${encodeURIComponent(args.text)}`;

		await telegram.sendMessage(
			context.chatId,
			context.threadId,
			"📝 Here's your draft. Tap the button to send it:",
			env,
			context.messageId,
			{
				inline_keyboard: [[
					{ text: "📤 Send draft", url: shareUrl }
				]]
			}
		);

		return { status: "success" };
	}
};
