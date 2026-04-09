import * as telegram from '../lib/telegram';

// Note: Telegram's sendMessageDraft (Bot API 9.5) is a STREAMING tool —
// it shows partial text while generating, not a "pre-fill input" feature.
// For pre-filling the user's input, Telegram's deep link share URL is the
// correct approach: https://t.me/share/url?text=...

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
