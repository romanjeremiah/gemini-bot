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

/**
 * Create a date_time entity for Telegram messages.
 * Renders the timestamp in the user's local timezone.
 * @param {number} offset - Character offset in the message text
 * @param {number} length - Length of the placeholder text
 * @param {number} unixTime - Unix timestamp (seconds)
 * @param {string} format - One of: 'wDT' (weekday+date+time), 'DT' (date+time), 'D' (date), 'T' (time), 'wD' (weekday+date), 't' (relative time), 'r' (relative), 'dT' (short date+time)
 * @returns {object} MessageEntity object
 */
export function dateTimeEntity(offset, length, unixTime, format = 'DT') {
	return { type: 'date_time', offset, length, unix_time: unixTime, date_time_format: format };
}

/**
 * Build a message text with an embedded date_time placeholder.
 * Returns { text, entities } ready for sendMessage.
 * @param {string} before - Text before the timestamp
 * @param {number} unixTime - Unix timestamp (seconds)
 * @param {string} after - Text after the timestamp
 * @param {string} format - date_time format string
 * @returns {{ text: string, entities: object[] }}
 */
export function buildDateTimeMessage(before, unixTime, after = '', format = 'DT') {
	// The placeholder text is what users on old clients see
	const date = new Date(unixTime * 1000);
	const placeholder = date.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
	const text = `${before}${placeholder}${after}`;
	const entity = dateTimeEntity(before.length, placeholder.length, unixTime, format);
	return { text, entities: [entity] };
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

	let res = await tgApi("sendMessage", env, payload);

	if (!res.ok && res.description?.includes("thread not found") && payload.message_thread_id) {
		console.warn(`⚠️ Thread ${payload.message_thread_id} not found — retrying in main chat`);
		delete payload.message_thread_id;
		delete payload.reply_parameters;
		res = await tgApi("sendMessage", env, payload);
	}

	if (!res.ok) {
		delete payload.parse_mode;
		payload.text = cleanText.replace(/<[^>]*>/g, "");
		return await tgApi("sendMessage", env, payload);
	}

	// Cache bot message context for reaction correlation (24h TTL)
	if (res.ok && res.result?.message_id && text.length > 20) {
		const plainText = cleanText.replace(/<[^>]*>/g, '').slice(0, 300);
		env.CHAT_KV.put(`msg_context_${chatId}_${res.result.message_id}`, plainText, { expirationTtl: 86400 }).catch(() => {});
	}

	return res;
}

// ---- Send Message with Entities (for date_time, custom_emoji, etc.) ----
// Uses the entities array instead of parse_mode. Pass pre-built entities from buildDateTimeMessage.
export async function sendMessageWithEntities(chatId, threadId, text, entities, env, replyId = null, markup = null) {
	const payload = {
		chat_id: chatId,
		text,
		entities,
		link_preview_options: { is_disabled: true }
	};
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (replyId) payload.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
	if (markup) payload.reply_markup = markup;
	return await tgApi("sendMessage", env, payload);
}

// ---- Send Message Draft (Bot API 9.3+, all bots since 9.5) ----
// Streams partial text to the user while the message is being generated.
// Call repeatedly with the same draft_id and growing text — Telegram animates the changes.
// Finalize with sendMessage when generation is complete (clears the draft bubble).
// https://core.telegram.org/bots/api#sendmessagedraft
export async function sendMessageDraft(chatId, threadId, draftId, text, env, replyId = null) {
	const payload = {
		chat_id: chatId,
		draft_id: draftId,
		text: text,  // plain text — no parse_mode for drafts to avoid mid-stream HTML errors
	};
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (replyId) payload.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
	return await tgApi("sendMessageDraft", env, payload);
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

// ---- Answer Callback Query ----
export async function answerCallbackQuery(callbackQueryId, env, text = null) {
	const payload = { callback_query_id: callbackQueryId };
	if (text) payload.text = text;
	return await tgApi("answerCallbackQuery", env, payload);
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

// ---- Send Poll (updated for Bot API 9.6) ----
export async function sendPoll(chatId, threadId, question, options, env, config = {}) {
	// Normalise options: accept plain strings or { text: ... } objects
	const normalisedOptions = options.map(o => typeof o === 'string' ? { text: o } : o);
	const payload = { chat_id: chatId, question, options: normalisedOptions, ...config };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	if (payload.correct_option_id !== undefined && !payload.correct_option_ids) {
		payload.correct_option_ids = [payload.correct_option_id];
		delete payload.correct_option_id;
	}
	return await tgApi("sendPoll", env, payload);
}

// ---- Send Location ----
export async function sendLocation(chatId, threadId, latitude, longitude, env) {
	const payload = { chat_id: chatId, latitude, longitude };
	if (threadId && threadId !== "default") payload.message_thread_id = Number(threadId);
	return await tgApi("sendLocation", env, payload);
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
	const arrayBuffer = await fileRes.arrayBuffer();
	// Use native Buffer for fast base64 encoding (no manual for-loop)
	const { Buffer } = await import('node:buffer');
	const base64 = Buffer.from(arrayBuffer).toString('base64');
	return { base64, buffer: arrayBuffer, filePath: info.result.file_path, fileSize: info.result.file_size || arrayBuffer.byteLength };
}

// ---- Register bot commands ----
export async function registerCommands(env) {
	return await tgApi("setMyCommands", env, {
		commands: [
			{ command: "listen", description: "Deep listening mode (brain dump)" },
			{ command: "done", description: "End listening mode and synthesise" },
			{ command: "architect", description: "Self-improvement analysis" },
			{ command: "schedule", description: "View and manage schedules" },
			{ command: "persona", description: "Switch AI personality" },
			{ command: "model", description: "Choose AI model (Pro/Flash)" },
			{ command: "mood", description: "Interactive mood check-in" },
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

// ---- Answer Inline Query ----
export async function answerInlineQuery(inlineQueryId, results, env, opts = {}) {
	return await tgApi("answerInlineQuery", env, {
		inline_query_id: inlineQueryId,
		results,
		cache_time: opts.cacheTime ?? 10,
		is_personal: opts.isPersonal ?? true,
	});
}
