import { sanitizeTelegramHTML } from './formatter';

// ---- Core helper ----
async function tgApi(method, env, payload) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});
	return await res.json();
}

// ---- Send text message ----
export async function sendMessage(chatId, threadId, text, env, replyId = null, markup = null) {
	const cleanText = sanitizeTelegramHTML(text);
	const payload = {
		chat_id: chatId,
		text: cleanText,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true }
	};
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (replyId) payload.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
	if (markup) payload.reply_markup = markup;

	const res = await tgApi("sendMessage", env, payload);
	if (!res.ok) {
		delete payload.parse_mode;
		payload.text = cleanText.replace(/<[^>]*>/g, "");
		return await tgApi("sendMessage", env, payload);
	}
	return res;
}

// ---- Edit existing message ----
export async function editMessage(chatId, msgId, text, env, markup = null) {
	const cleanText = sanitizeTelegramHTML(text);
	const payload = { chat_id: chatId, message_id: msgId, text: cleanText, parse_mode: "HTML" };
	if (markup) payload.reply_markup = markup;
	const res = await tgApi("editMessageText", env, payload);
	if (!res.ok) {
		delete payload.parse_mode;
		payload.text = cleanText.replace(/<[^>]*>/g, "");
		await tgApi("editMessageText", env, payload);
	}
}

// ---- Send voice note ----
export async function sendVoice(chatId, threadId, buffer, env, replyId = null) {
	const fd = new FormData();
	fd.append("chat_id", chatId);
	if (threadId && threadId !== "default") fd.append("message_thread_id", Number(threadId));
	fd.append("voice", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
	if (replyId) fd.append("reply_parameters", JSON.stringify({ message_id: replyId, allow_sending_without_reply: true }));
	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendVoice`, { method: "POST", body: fd });
}

// ---- Chat action (typing, upload_voice, etc.) ----
export async function sendChatAction(chatId, threadId, action, env) {
	const payload = { chat_id: chatId, action };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	await tgApi("sendChatAction", env, payload);
}

// ---- Emoji reaction ----
export async function sendReaction(chatId, messageId, emoji, env) {
	await tgApi("setMessageReaction", env, {
		chat_id: chatId, message_id: messageId,
		reaction: [{ type: "emoji", emoji }]
	});
}

// ---- Pin message ----
export async function pinMessage(chatId, messageId, env) {
	return await tgApi("pinChatMessage", env, {
		chat_id: chatId, message_id: messageId, disable_notification: true
	});
}

// ---- Download file from Telegram with size guard ----
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

export async function downloadFile(fileId, env) {
	const info = await tgApi("getFile", env, { file_id: fileId });
	if (!info.ok) throw new Error("Failed to get file info");

	const filePath = info.result.file_path;
	const fileSize = info.result.file_size || 0;
	if (fileSize > MAX_FILE_SIZE) {
		throw new Error(`File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
	}

	const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
	const arrayBuffer = await fileRes.arrayBuffer();
	const binary = new Uint8Array(arrayBuffer);
	let b64 = '';
	for (let i = 0; i < binary.length; i++) b64 += String.fromCharCode(binary[i]);

	return { base64: btoa(b64), filePath };
}

// ---- Register bot commands ----
export async function registerCommands(env) {
	return await tgApi("setMyCommands", env, {
		commands: [
			{ command: "persona", description: "Switch AI personality" },
			{ command: "clear", description: "Reset conversation history" },
			{ command: "memories", description: "View saved facts" },
			{ command: "forget", description: "Delete all memories" },
			{ command: "start", description: "Welcome message" }
		]
	});
}

// ---- Verify webhook secret ----
export function verifyWebhook(request, env) {
	const secret = env.WEBHOOK_SECRET;
	if (!secret) return true; // No secret configured, skip check
	const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
	return header === secret;
}
