import { personas, FORMATTING_RULES } from '../config/personas';
import { streamCompletion, generateImage } from '../lib/ai/gemini';
import { toolRegistry } from '../tools';
import * as telegram from '../lib/telegram';
import * as memoryStore from '../services/memoryStore';
import { generateSpeech } from '../lib/tts';
import { buildChecklistText, toStrikethrough } from '../tools/checklist';

const HISTORY_LENGTH = 24;
const HISTORY_TTL = 604800;

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight'];

function getPersona(key) {
	return personas[key] ? key : "gemini";
}

function getMediaFromMessage(msg) {
	if (msg.photo) return { fileId: msg.photo[msg.photo.length - 1].file_id, mimeHint: "image/jpeg" };
	if (msg.voice) return { fileId: msg.voice.file_id, mimeHint: msg.voice.mime_type || "audio/ogg" };
	if (msg.audio) return { fileId: msg.audio.file_id, mimeHint: msg.audio.mime_type || "audio/mpeg" };
	if (msg.video_note) return { fileId: msg.video_note.file_id, mimeHint: "video/mp4" };
	if (msg.document && ["image/", "audio/", "video/", "application/pdf", "text/"].some(s => (msg.document.mime_type || "").startsWith(s))) {
		return { fileId: msg.document.file_id, mimeHint: msg.document.mime_type };
	}
	if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) return { fileId: msg.sticker.file_id, mimeHint: "image/webp" };
	return null;
}

async function handleCommand(command, msg, env) {
	const chatId = msg.chat.id;
	const threadId = msg.message_thread_id || "default";
	switch (command) {
		case "/start": {
			const pKey = getPersona(await env.CHAT_KV.get(`persona_${chatId}`));
			await telegram.sendMessage(chatId, threadId, `👋 Hey! I'm <b>${personas[pKey].name}</b>.\n\nSend me text, voice, photos, or documents.\n\n<b>Commands:</b>\n/persona — Switch personality\n/memories — View saved facts\n/clear — Reset conversation\n/forget — Delete all memories`, env);
			return true;
		}
		case "/persona":
			await telegram.sendMessage(chatId, threadId, "Select your active AI protocol:", env, null, {
				inline_keyboard: [
					[{ text: "✨ Gemini", callback_data: "set_persona_gemini" }, { text: "🧠 Thinking Partner", callback_data: "set_persona_thinking_partner" }],
					[{ text: "🟢 Mooncake", callback_data: "set_persona_mooncake" }, { text: "🚀 HUE", callback_data: "set_persona_hue" }],
					[{ text: "💛 Tribore", callback_data: "set_persona_tribore" }]
				]
			});
			return true;
		case "/clear":
			await env.CHAT_KV.delete(`chat_${chatId}_${threadId}`);
			await telegram.sendMessage(chatId, threadId, "🧹 Conversation history cleared.", env);
			return true;
		case "/memories": {
			const mems = await memoryStore.getMemories(env, chatId, 40);
			if (!mems.length) { await telegram.sendMessage(chatId, threadId, "📭 No memories saved.", env); return true; }
			const factual = {}, therapeutic = {};
			for (const m of mems) {
				const target = THERAPEUTIC_CATEGORIES.includes(m.category) ? therapeutic : factual;
				if (!target[m.category]) target[m.category] = [];
				target[m.category].push(m);
			}
			let t = "🧠 <b>Saved Memories</b>\n\n";
			if (Object.keys(factual).length) {
				for (const [c, items] of Object.entries(factual)) {
					t += `<b>${c}</b>\n`;
					items.forEach(m => t += `• ${m.fact}\n`);
					t += "\n";
				}
			}
			if (Object.keys(therapeutic).length) {
				t += "🔍 <b>Therapeutic Observations</b>\n\n";
				for (const [c, items] of Object.entries(therapeutic)) {
					t += `<b>${c}</b>\n`;
					items.forEach(m => { const star = m.importance_score >= 2 ? "⭐ " : ""; t += `• ${star}${m.fact}\n`; });
					t += "\n";
				}
			}
			await telegram.sendMessage(chatId, threadId, t + "<i>Use /forget to clear all.</i>", env);
			return true;
		}
		case "/forget":
			await telegram.sendMessage(chatId, threadId, "⚠️ Delete all saved memories?", env, null, { inline_keyboard: [[{ text: "✅ Yes, delete all", callback_data: "confirm_forget" }, { text: "❌ Cancel", callback_data: "cancel_forget" }]] });
			return true;
		default: return false;
	}
}

export async function handleMessage(msg, env) {
	const chatId = msg.chat.id, messageId = msg.message_id, threadId = msg.message_thread_id || "default";

	try {
		const firstName = msg.from.first_name || "User", userText = msg.text || msg.caption || "";
		const cmdMatch = userText.match(/^\/(\w+)(@\w+)?/);
		if (cmdMatch && await handleCommand(`/${cmdMatch[1]}`, msg, env)) return;

		await telegram.sendChatAction(chatId, threadId, "typing", env);

		const [memCtx, personaKey, history] = await Promise.all([
			memoryStore.getFormattedContext(env, chatId),
			env.CHAT_KV.get(`persona_${chatId}`),
			env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: "json" })
		]);

		const activePersona = getPersona(personaKey);
		let hist = history || [];
		let replyContext = "";
		if (msg.reply_to_message) replyContext = `\n[User is replying to ${msg.reply_to_message.from?.first_name || "Someone"}: "${(msg.reply_to_message.text || msg.reply_to_message.caption || "").slice(0, 500)}"]\n`;

		const sysPrompt = `${personas[activePersona].instruction}\n${FORMATTING_RULES}\nUser: ${firstName}\nLondon Time: ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })}\nUnix Anchor: ${Math.floor(Date.now() / 1000)}\n\nMEMORY:\n${memCtx}`;

		let userParts = [];
		if (replyContext) userParts.push({ text: replyContext + (userText || "See attached media.") });
		else if (userText) userParts.push({ text: userText });

		let uploadedImageBase64 = null, uploadedImageMime = null;
		const media = getMediaFromMessage(msg);
		if (media) {
			try {
				const { base64 } = await telegram.downloadFile(media.fileId, env);
				userParts.push({ inlineData: { mimeType: media.mimeHint, data: base64 } });
				if (media.mimeHint.startsWith("image/")) { uploadedImageBase64 = base64; uploadedImageMime = media.mimeHint; }
				if (!userText && !replyContext) userParts.unshift({ text: "Describe or respond to this media." });
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `⚠️ Media error: ${e.message}`, env, messageId);
				if (userParts.length === 0) return;
			}
		}

		if (userParts.length === 0) return;
		hist.push({ role: "user", parts: userParts });

		let isComplete = false, fullText = "", lastTypingTime = Date.now(), lastSentMsgId = null;

		while (!isComplete) {
			const stream = streamCompletion(hist, sysPrompt, env);
			let passText = "", toolCalls = [], rawModelParts = null; // rawModelParts preserves thought signatures

			for await (const chunk of stream) {
				if (chunk.type === 'text') {
					passText += chunk.text;
					fullText += chunk.text;
					if (Date.now() - lastTypingTime > 4000) { telegram.sendChatAction(chatId, threadId, "typing", env); lastTypingTime = Date.now(); }
				} else if (chunk.type === 'functionCall') {
					toolCalls.push(...chunk.calls);
				} else if (chunk.type === 'modelParts') {
					rawModelParts = chunk.parts; // Capture complete parts incl. thought signatures
				}
			}

			if (toolCalls.length > 0) {
				// Use raw model parts when available — preserves thought signatures for Gemini 3.x
				const modelParts = rawModelParts ?? (passText.trim() ? [{ text: passText }, ...toolCalls] : toolCalls);
				hist.push({ role: "model", parts: modelParts });

				await telegram.sendChatAction(chatId, threadId, "typing", env);
				lastTypingTime = Date.now();

				let toolRes = [];
				for (const call of toolCalls) {
					const name = call.functionCall.name, args = call.functionCall.args;
					let result = { status: "success" };
					try {
						if (name === "send_voice_note") {
							await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
							const buf = await generateSpeech(args.text_to_speak, activePersona, env);
							await telegram.sendVoice(chatId, threadId, buf, env, messageId);
						} else if (name === "generate_image") {
							await telegram.sendChatAction(chatId, threadId, "upload_photo", env);
							console.log("🎨 Image gen started:", args.prompt?.slice(0, 80));
							const isEdit = args.edit_mode && uploadedImageBase64;
							const { imageBase64, mimeType, caption } = await generateImage(args.prompt, env, isEdit ? uploadedImageBase64 : null, isEdit ? uploadedImageMime : null);
							const bstr = atob(imageBase64);
							const bytes = new Uint8Array(bstr.length);
							for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
							await env.CHAT_KV.put(`last_img_${chatId}_${threadId}`, JSON.stringify({ prompt: args.prompt }), { expirationTtl: 86400 });
							await telegram.sendPhoto(chatId, threadId, bytes, mimeType, env, messageId, caption?.slice(0, 1024), {
								inline_keyboard: [[{ text: "🔄 Regenerate", callback_data: "img_regen" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]]
							});
							result = { status: "success", note: "Image sent" };
						} else {
							const tool = toolRegistry[name];
							if (tool) result = await tool.execute(args, env, { userId: msg.from.id, chatId, threadId, messageId, firstName, activePersona, lastBotMessageId: lastSentMsgId });
						}
					} catch (e) {
						console.error(`Tool ${name} error:`, e.message);
						result = { status: "error", message: e.message };
					}
					toolRes.push({ functionResponse: { name, response: result } });
				}
				hist.push({ role: "user", parts: toolRes });
			} else {
				isComplete = true;
				if (fullText.trim()) {
					const btns = { inline_keyboard: [[{ text: "🔊 Voice", callback_data: "action_voice" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]] };
					const sent = await telegram.sendMessage(chatId, threadId, fullText, env, messageId, btns);
					lastSentMsgId = sent?.result?.message_id;
					if (passText.trim()) hist.push({ role: "model", parts: [{ text: passText }] });
				}
			}
		}

		// Clean history: strip tool calls and binary media, then truncate
		let cleanHistory = hist
			.map(h => ({ role: h.role, parts: h.parts.filter(p => !p.functionCall && !p.functionResponse).map(p => p.inlineData ? { text: "[Media]" } : p) }))
			.filter(h => h.parts.length > 0)
			.slice(-HISTORY_LENGTH);

		if (cleanHistory.length > 0 && cleanHistory[0].role === "model") cleanHistory.shift();

		await env.CHAT_KV.put(`chat_${chatId}_${threadId}`, JSON.stringify(cleanHistory), { expirationTtl: HISTORY_TTL });

	} catch (err) {
		console.error("❌ handleMessage crash:", err.message, err.stack);
		try {
			await telegram.sendMessage(chatId, threadId, `⚠️ ${err.message?.slice(0, 150) || "Unknown error"}`, env, messageId);
		} catch (sendErr) {
			console.error("❌ Failed to send error msg:", sendErr.message);
		}
	}
}

export async function handleCallback(callbackQuery, env) {
	const chatId = callbackQuery.message.chat.id, threadId = callbackQuery.message.message_thread_id || "default";
	const data = callbackQuery.data, msgId = callbackQuery.message.message_id;

	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ callback_query_id: callbackQuery.id })
	});

	if (data.startsWith("set_persona_")) {
		const key = data.replace("set_persona_", "");
		if (personas[key]) {
			await env.CHAT_KV.put(`persona_${chatId}`, key);
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			await telegram.sendMessage(chatId, threadId, `✅ Switched to: <b>${personas[key].name}</b>`, env);
		}
	} else if (data === "confirm_forget") {
		await memoryStore.deleteAllMemories(env, chatId);
		await telegram.editMessage(chatId, msgId, "🗑️ All memories deleted.", env);
	} else if (data === "cancel_forget") {
		await telegram.editMessage(chatId, msgId, "👍 Memories kept.", env);
	} else if (data === "action_voice") {
		const botText = callbackQuery.message.text || "";
		if (botText) {
			const voicePersona = getPersona(await env.CHAT_KV.get(`persona_${chatId}`));
			try {
				await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
				const audio = await generateSpeech(botText, voicePersona, env);
				await telegram.sendVoice(chatId, threadId, audio, env, msgId);
			} catch (e) { console.error("Voice err:", e.message); }
		}
		await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
	} else if (data === "action_delete_msg") {
		await telegram.deleteMessage(chatId, msgId, env);
	} else if (data.startsWith("chk|")) {
		const parts = data.split("|");
		const index = parseInt(parts[1]);
		const title = parts[2] || "Checklist";
		const markup = callbackQuery.message.reply_markup;
		if (!markup?.inline_keyboard?.[index]?.[0]) return;
		const button = markup.inline_keyboard[index][0];
		if (button.text.startsWith("✅")) {
			const rawText = button.text.replace(/^✅\s+/, "").replace(/\u0336/g, "");
			button.text = `☐  ${rawText}`;
		} else {
			const taskText = button.text.replace(/^☐\s+/, "");
			button.text = `✅  ${toStrikethrough(taskText)}`;
		}
		const newText = buildChecklistText(title, markup.inline_keyboard);
		await telegram.editMessage(chatId, msgId, newText, env, markup);
	} else if (data === "img_regen") {
		try {
			await telegram.sendChatAction(chatId, threadId, "upload_photo", env);
			const kvData = await env.CHAT_KV.get(`last_img_${chatId}_${threadId}`, { type: "json" });
			if (!kvData?.prompt) { await telegram.sendMessage(chatId, threadId, "⚠️ No previous prompt found.", env); return; }
			const { imageBase64, mimeType, caption } = await generateImage(kvData.prompt, env);
			const bstr = atob(imageBase64);
			const bytes = new Uint8Array(bstr.length);
			for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
			await telegram.sendPhoto(chatId, threadId, bytes, mimeType, env, null, caption?.slice(0, 1024), {
				inline_keyboard: [[{ text: "🔄 Regenerate", callback_data: "img_regen" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]]
			});
		} catch (e) {
			console.error("Image regen error:", e.message);
			await telegram.sendMessage(chatId, threadId, `⚠️ Regeneration failed: ${e.message.slice(0, 100)}`, env);
		}
	}
}
