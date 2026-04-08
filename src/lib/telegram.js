import { sanitizeTelegramHTML } from './formatter';

// ---- Core helper ----
async function tgApi(method, env, payload) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});
	const data = await res.json();
	if (!data.ok && !data.description?.includes("message is not modified")) {
		console.error(`❌ Telegram API Error [${method}]:`, data.description);
	}
	return data;
}

// ---- Send text message ----
export async function sendMessage(chatId, threadId, text, env, replyId = null, markup = null, effectId = null, quote = null) {
	const cleanText = sanitizeTelegramHTML(text);
	const payload = {
		chat_id: chatId,
		text: cleanText,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true }
	};
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (replyId) {
		payload.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
		if (quote) payload.reply_parameters.quote = quote;
	}
	if (markup) payload.reply_markup = markup;
	if (effectId) payload.message_effect_id = effectId;

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
		if (res.description?.includes("message is not modified")) return res;
		delete payload.parse_mode;
		payload.text = cleanText.replace(/<[^>]*>/g, "");
		await tgApi("editMessageText", env, payload);
	}
	return res;
}

// ---- Edit Reply Markup ----
export async function editMessageReplyMarkup(chatId, msgId, markup, env) {
	const payload = { chat_id: chatId, message_id: msgId, reply_markup: markup || { inline_keyboard: [] } };
	return await tgApi("editMessageReplyMarkup", env, payload);
}

// ---- Delete Message ----
export async function deleteMessage(chatId, msgId, env) {
	return await tgApi("deleteMessage", env, { chat_id: chatId, message_id: msgId });
}

// ---- Send photo from binary buffer ----
export async function sendPhoto(chatId, threadId, buffer, mimeType, env, replyId = null, caption = null, markup = null) {
	const extMap = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
	const ext = extMap[mimeType] || "png";

	const fd = new FormData();
	fd.append("chat_id", chatId);
	if (threadId && threadId !== "default") fd.append("message_thread_id", Number(threadId));
	fd.append("photo", new Blob([buffer], { type: mimeType }), `image.${ext}`);
	if (caption) {
		fd.append("caption", sanitizeTelegramHTML(caption).slice(0, 1024));
		fd.append("parse_mode", "HTML");
	}
	if (replyId) fd.append("reply_parameters", JSON.stringify({ message_id: replyId, allow_sending_without_reply: true }));
	if (markup) fd.append("reply_markup", JSON.stringify(markup));

	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, { method: "POST", body: fd });
	const data = await res.json();
	if (!data.ok) {
		console.error("❌ Telegram API Error [sendPhoto]:", data.description);
		if (caption) {
			const fd2 = new FormData();
			fd2.append("chat_id", chatId);
			if (threadId && threadId !== "default") fd2.append("message_thread_id", Number(threadId));
			fd2.append("photo", new Blob([buffer], { type: mimeType }), `image.${ext}`);
			fd2.append("caption", caption.replace(/<[^>]*>/g, "").slice(0, 1024));
			if (replyId) fd2.append("reply_parameters", JSON.stringify({ message_id: replyId, allow_sending_without_reply: true }));
			if (markup) fd2.append("reply_markup", JSON.stringify(markup));
			return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, { method: "POST", body: fd2 });
		}
	}
	return data;
}

// ---- Send native checklist (requires business_connection_id) ----
// InputChecklistTask requires: id (Integer), text (String), optional parse_mode, text_entities
export async function sendChecklist(chatId, threadId, businessConnectionId, title, tasks, env, options = {}) {
	const checklist = {
		title: title,
		tasks: tasks.map((t, idx) => ({
			id: idx,
			text: typeof t === 'string' ? t : t.text,
			...(t.parse_mode ? { parse_mode: t.parse_mode } : {})
		})),
		others_can_mark_tasks_as_done: options.othersCanMark !== false,
		others_can_add_tasks: options.othersCanAdd === true
	};
	if (options.parseMode) checklist.parse_mode = options.parseMode;

	const payload = {
		business_connection_id: businessConnectionId,
		chat_id: chatId,
		checklist: checklist
	};
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);

	return await tgApi("sendChecklist", env, payload);
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

// ---- Chat action ----
export async function sendChatAction(chatId, threadId, action, env) {
	const payload = { chat_id: chatId, action };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	await tgApi("sendChatAction", env, payload);
}

// ---- Emoji reaction ----
export async function sendReaction(chatId, messageId, emoji, env) {
	if (!emoji) return;
	const singleEmoji = Array.isArray(emoji) ? emoji[0] : emoji;
	await tgApi("setMessageReaction", env, {
		chat_id: chatId, message_id: messageId,
		reaction: [{ type: "emoji", emoji: singleEmoji }]
	});
}

// ---- Pin message ----
export async function pinMessage(chatId, messageId, env) {
	return await tgApi("pinChatMessage", env, { chat_id: chatId, message_id: messageId, disable_notification: true });
}

// ---- Send Poll ----
export async function sendPoll(chatId, threadId, question, options, env, config = {}) {
	const payload = { chat_id: chatId, question, options, ...config };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	return await tgApi("sendPoll", env, payload);
}

// ---- Send Location ----
export async function sendLocation(chatId, threadId, latitude, longitude, env) {
	const payload = { chat_id: chatId, latitude, longitude };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	return await tgApi("sendLocation", env, payload);
}

// ---- Send Message Draft (Bot API 9.5) ----
export async function sendMessageDraft(chatId, threadId, text, env, replyId = null) {
	const cleanText = sanitizeTelegramHTML(text);
	const payload = { chat_id: chatId, text: cleanText, parse_mode: "HTML" };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (replyId) payload.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
	const res = await tgApi("sendMessageDraft", env, payload);
	if (!res.ok) {
		delete payload.parse_mode;
		payload.text = cleanText.replace(/<[^>]*>/g, "");
		return await tgApi("sendMessageDraft", env, payload);
	}
	return res;
}

// ---- Forward / Copy Message ----
export async function copyMessage(chatId, threadId, fromChatId, messageId, env) {
	const payload = { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	return await tgApi("copyMessage", env, payload);
}

export async function forwardMessage(chatId, threadId, fromChatId, messageId, env) {
	const payload = { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	return await tgApi("forwardMessage", env, payload);
}

// ---- Send Document ----
export async function sendDocument(chatId, threadId, buffer, filename, mimeType, env, replyId = null) {
	const fd = new FormData();
	fd.append("chat_id", chatId);
	if (threadId && threadId !== "default") fd.append("message_thread_id", Number(threadId));
	fd.append("document", new Blob([buffer], { type: mimeType }), filename);
	if (replyId) fd.append("reply_parameters", JSON.stringify({ message_id: replyId, allow_sending_without_reply: true }));
	return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: "POST", body: fd });
}

// ---- Download file with size guard ----
const MAX_FILE_SIZE = 20 * 1024 * 1024;
export async function downloadFile(fileId, env) {
	const info = await tgApi("getFile", env, { file_id: fileId });
	if (!info.ok) throw new Error("Failed to get file info");
	if ((info.result.file_size || 0) > MAX_FILE_SIZE) throw new Error(`File too large: ${(info.result.file_size / 1024 / 1024).toFixed(1)} MB`);
	const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
	const binary = new Uint8Array(await fileRes.arrayBuffer());
	let b64 = '';
	for (let i = 0; i < binary.length; i++) b64 += String.fromCharCode(binary[i]);
	return { base64: btoa(b64), filePath: info.result.file_path };
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
	return !secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}
