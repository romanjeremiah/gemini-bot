import { personas, FORMATTING_RULES } from '../config/personas';
import { getCompletion } from '../lib/ai/gemini';
import { toolRegistry } from '../tools';
import * as telegram from '../lib/telegram';
import * as memoryStore from '../services/memoryStore';
import { generateSpeech } from '../lib/tts';

// ---- Media extraction ----
function getMediaFromMessage(msg) {
	if (msg.photo) return { fileId: msg.photo[msg.photo.length - 1].file_id, mimeHint: "image/jpeg" };
	if (msg.voice) return { fileId: msg.voice.file_id, mimeHint: msg.voice.mime_type || "audio/ogg" };
	if (msg.audio) return { fileId: msg.audio.file_id, mimeHint: msg.audio.mime_type || "audio/mpeg" };
	if (msg.video_note) return { fileId: msg.video_note.file_id, mimeHint: "video/mp4" };
	if (msg.document) {
		const mime = msg.document.mime_type || "";
		const supported = ["image/", "audio/", "video/", "application/pdf", "text/"];
		if (supported.some(s => mime.startsWith(s))) return { fileId: msg.document.file_id, mimeHint: mime };
	}
	if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
		return { fileId: msg.sticker.file_id, mimeHint: "image/webp" };
	}
	return null;
}

// ---- Command handlers ----
async function handleCommand(command, msg, env) {
	const chatId = msg.chat.id;
	const threadId = msg.message_thread_id || "default";

	switch (command) {
		case "/start": {
			const pKey = await env.CHAT_KV.get(`persona_${chatId}`) || "gemini";
			await telegram.sendMessage(chatId, threadId,
				`👋 Hey! I'm <b>${personas[pKey].name}</b>.\n\nSend me text, voice, photos, or documents.\n\n<b>Commands:</b>\n/persona — Switch personality\n/memories — View saved facts\n/clear — Reset conversation\n/forget — Delete all memories`,
				env);
			return true;
		}
		case "/persona": {
			const kb = { inline_keyboard: [
				[{ text: "✨ Gemini", callback_data: "set_persona_gemini" }, { text: "🧠 Thinking Partner", callback_data: "set_persona_thinking_partner" }],
				[{ text: "🫂 Honest Friend", callback_data: "set_persona_honest_friend" }, { text: "🚀 HUE", callback_data: "set_persona_hue" }]
			]};
			await telegram.sendMessage(chatId, threadId, "Select your active AI protocol:", env, null, kb);
			return true;
		}
		case "/clear": {
			await env.CHAT_KV.delete(`chat_${chatId}_${threadId}`);
			await telegram.sendMessage(chatId, threadId, "🧹 Conversation history cleared.", env);
			return true;
		}
		case "/memories": {
			const memories = await memoryStore.getMemories(env, chatId, 30);
			if (!memories.length) {
				await telegram.sendMessage(chatId, threadId, "📭 No memories saved yet.", env);
				return true;
			}
			const grouped = {};
			for (const m of memories) {
				if (!grouped[m.category]) grouped[m.category] = [];
				grouped[m.category].push(m.fact);
			}
			let text = "🧠 <b>Saved Memories</b>\n\n";
			for (const [cat, facts] of Object.entries(grouped)) {
				text += `<b>${cat}</b>\n`;
				for (const f of facts) text += `• ${f}\n`;
				text += "\n";
			}
			text += "<i>Use /forget to clear all.</i>";
			await telegram.sendMessage(chatId, threadId, text, env);
			return true;
		}
		case "/forget": {
			const kb = { inline_keyboard: [[
				{ text: "✅ Yes, delete all", callback_data: "confirm_forget" },
				{ text: "❌ Cancel", callback_data: "cancel_forget" }
			]]};
			await telegram.sendMessage(chatId, threadId, "⚠️ Delete all saved memories?", env, null, kb);
			return true;
		}
		default:
			return false;
	}
}

// ---- Main message handler ----
export async function handleMessage(msg, env) {
	const chatId = msg.chat.id;
	const messageId = msg.message_id;
	const threadId = msg.message_thread_id || "default";
	const firstName = msg.from.first_name || "User";
	const userText = msg.text || msg.caption || "";

	// Handle commands
	const cmdMatch = userText.match(/^\/(\w+)(@\w+)?/);
	if (cmdMatch) {
		const handled = await handleCommand(`/${cmdMatch[1]}`, msg, env);
		if (handled) return;
	}

	// Send placeholder
	const placeholder = await telegram.sendMessage(chatId, threadId, "💭", env, messageId);
	const placeholderMsgId = placeholder?.result?.message_id;

	await telegram.sendChatAction(chatId, threadId, "typing", env);

	// Load memories
	const memories = await memoryStore.getMemories(env, chatId);
	const memCtx = memories.map(m => `- [${m.category}] ${m.fact}`).join("\n") || "- No facts saved yet.";

	const activePersona = await env.CHAT_KV.get(`persona_${chatId}`) || "gemini";
	const nowUnix = Math.floor(Date.now() / 1000);
	const nowLondon = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });

	// Build reply-to context
	let replyContext = "";
	if (msg.reply_to_message) {
		const replied = msg.reply_to_message;
		const repliedText = replied.text || replied.caption || "";
		const repliedFrom = replied.from?.first_name || "Someone";
		if (repliedText) replyContext = `\n[User is replying to ${repliedFrom}: "${repliedText.slice(0, 500)}"]\n`;
	}

	const sysPrompt = `${personas[activePersona].instruction}
${FORMATTING_RULES}
User: ${firstName}
London Time: ${nowLondon}
Unix Anchor: ${nowUnix}

CONTEXT PROTOCOL:
When using 'set_reminder', you MUST provide a deep 'context' string.
Identify the underlying need or emotional state the user is expressing.
This metadata helps the user overcome executive dysfunction when the reminder triggers later.

MEMORY:
${memCtx}`;

	// Load history
	let history = await env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: "json" }) || [];

	// Build user message parts
	let userParts = [];
	if (replyContext) {
		userParts.push({ text: replyContext + (userText || "See attached media.") });
	} else if (userText) {
		userParts.push({ text: userText });
	}

	// Handle media (photos, voice, documents, stickers, audio)
	const media = getMediaFromMessage(msg);
	if (media) {
		try {
			const { base64 } = await telegram.downloadFile(media.fileId, env);
			userParts.push({ inlineData: { mimeType: media.mimeHint, data: base64 } });
			if (!userText && !replyContext) userParts.unshift({ text: "Describe or respond to this media." });
		} catch (e) {
			console.error("Media download error:", e.message);
			if (placeholderMsgId) await telegram.editMessage(chatId, placeholderMsgId, `⚠️ ${e.message}`, env);
			if (userParts.length === 0) return;
		}
	}

	if (userParts.length === 0) return;
	history.push({ role: "user", parts: userParts });

	// AI loop with error handling
	try {
		let data = await getCompletion(history, sysPrompt, env);
		let calls = data.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];

		while (calls.length > 0) {
			history.push(data.candidates[0].content);
			let toolResponses = [];

			for (const call of calls) {
				const toolName = call.functionCall.name;
				const args = call.functionCall.args;
				let result = { status: "success" };

				try {
					// Voice is handled specially (needs TTS + Telegram)
					if (toolName === "send_voice_note") {
						await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
						const buf = await generateSpeech(args.text_to_speak, activePersona, env);
						await telegram.sendVoice(chatId, threadId, buf, env, messageId);
					} else {
						const tool = toolRegistry[toolName];
						if (tool) result = await tool.execute(args, env, {
							userId: msg.from.id,
							chatId,
							threadId,
							messageId,
							firstName,
							activePersona,
							lastBotMessageId: placeholderMsgId
						});
					}
				} catch (toolErr) {
					console.error(`Tool ${toolName} error:`, toolErr.message);
					result = { status: "error", message: toolErr.message };
				}

				toolResponses.push({ functionResponse: { name: toolName, response: result } });
			}

			history.push({ role: "user", parts: toolResponses });
			data = await getCompletion(history, sysPrompt, env);
			calls = data.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];
		}

		// Final response
		const aiText = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
		if (aiText) {
			const voiceButton = { inline_keyboard: [[{ text: "🔊 Voice", callback_data: "action_voice" }]] };
			if (placeholderMsgId) {
				await telegram.editMessage(chatId, placeholderMsgId, aiText, env, voiceButton);
			} else {
				await telegram.sendMessage(chatId, threadId, aiText, env, messageId, voiceButton);
			}
			history.push({ role: "model", parts: [{ text: aiText }] });

			// Clean history: strip tool calls and binary media
			const cleanHistory = history
				.map(h => ({ role: h.role, parts: h.parts.filter(p => !p.functionCall && !p.functionResponse).map(p => p.inlineData ? { text: "[Media]" } : p) }))
				.filter(h => h.parts.length > 0)
				.slice(-14);
			await env.CHAT_KV.put(`chat_${chatId}_${threadId}`, JSON.stringify(cleanHistory), { expirationTtl: 86400 });
		} else if (placeholderMsgId) {
			await telegram.editMessage(chatId, placeholderMsgId, "🤔 Processed, but nothing to add.", env);
		}

	} catch (err) {
		console.error("Gemini error:", err.message);
		const errorText = `⚠️ ${err.message.slice(0, 150)}`;
		if (placeholderMsgId) await telegram.editMessage(chatId, placeholderMsgId, errorText, env);
		else await telegram.sendMessage(chatId, threadId, errorText, env, messageId);
	}
}

// ---- Callback handler ----
export async function handleCallback(callbackQuery, env) {
	const chatId = callbackQuery.message.chat.id;
	const threadId = callbackQuery.message.message_thread_id || "default";
	const data = callbackQuery.data;

	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ callback_query_id: callbackQuery.id })
	});

	if (data.startsWith("set_persona_")) {
		const key = data.replace("set_persona_", "");
		if (!personas[key]) return;
		await env.CHAT_KV.put(`persona_${chatId}`, key);
		await telegram.sendMessage(chatId, threadId, `✅ Switched to: <b>${personas[key].name}</b>`, env);
	}
	else if (data === "confirm_forget") {
		await memoryStore.deleteAllMemories(env, chatId);
		await telegram.editMessage(chatId, callbackQuery.message.message_id, "🗑️ All memories deleted.", env);
	}
	else if (data === "cancel_forget") {
		await telegram.editMessage(chatId, callbackQuery.message.message_id, "👍 Memories kept.", env);
	}
	else if (data === "action_voice") {
		const botText = callbackQuery.message.text || "";
		if (!botText) return;
		const pKey = await env.CHAT_KV.get(`persona_${chatId}`) || "gemini";
		try {
			await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
			const audio = await generateSpeech(botText, pKey, env);
			await telegram.sendVoice(chatId, threadId, audio, env, callbackQuery.message.message_id);
		} catch (e) {
			console.error("Voice callback error:", e.message);
		}
		// Remove button after use
		await telegram.editMessage(chatId, callbackQuery.message.message_id, callbackQuery.message.text, env);
	}
}
