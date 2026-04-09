import { personas, FORMATTING_RULES, MENTAL_HEALTH_DIRECTIVE, SECOND_BRAIN_DIRECTIVE } from '../config/personas';
import { createChat, sendChatMessage, sendChatMessageStream, generateImage, setupCache, PRIMARY_TEXT_MODEL, FALLBACK_TEXT_MODEL, generateShortResponse } from '../lib/ai/gemini';
import { toolRegistry } from '../tools';
import * as telegram from '../lib/telegram';
import * as memoryStore from '../services/memoryStore';
import * as vectorStore from '../services/vectorStore';
import * as mediaStore from '../services/mediaStore';
import { uploadToFilesAPI, shouldUseFilesAPI } from '../services/filesApi';
import { upsertUser, buildUserIdentity } from '../services/userStore';
import { generateSpeech } from '../lib/tts';
import { buildChecklistText } from '../tools/checklist';
import * as moodStore from '../services/moodStore';

const HISTORY_LENGTH = 24;
const HISTORY_TTL = 604800;
const DRAFT_THROTTLE_MS = 500; // minimum ms between sendMessageDraft calls

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight'];

function getPersona(key) {
	return personas[key] ? key : "tenon";
}

function sanitizeHistory(hist) {
	const cleaned = hist
		.map(turn => {
			const textParts = (turn.parts || []).filter(p =>
				p.text && !p.functionCall && !p.functionResponse && !p.inlineData && !p.thought
			);
			if (!textParts.length) return null;
			return { role: turn.role, parts: textParts };
		})
		.filter(Boolean);
	while (cleaned.length > 0 && cleaned[0].role !== "user") cleaned.shift();
	const merged = [];
	for (const turn of cleaned) {
		if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
			merged[merged.length - 1].parts.push(...turn.parts);
		} else {
			merged.push({ role: turn.role, parts: [...turn.parts] });
		}
	}
	return merged;
}

function getMediaFromMessage(msg) {
	let fileId = null, mimeHint = null;

	if (msg.photo) { fileId = msg.photo[msg.photo.length - 1].file_id; mimeHint = "image/jpeg"; }
	else if (msg.voice) { fileId = msg.voice.file_id; mimeHint = "audio/ogg"; }
	else if (msg.audio) { fileId = msg.audio.file_id; mimeHint = msg.audio.mime_type || "audio/mpeg"; }
	else if (msg.video) { fileId = msg.video.file_id; mimeHint = msg.video.mime_type || "video/mp4"; }
	else if (msg.video_note) { fileId = msg.video_note.file_id; mimeHint = "video/mp4"; }
	else if (msg.document && ["image/", "audio/", "video/", "application/pdf", "text/"].some(s => (msg.document.mime_type || "").startsWith(s))) {
		fileId = msg.document.file_id; mimeHint = msg.document.mime_type;
	}
	else if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) { fileId = msg.sticker.file_id; mimeHint = "image/webp"; }

	if (!fileId) return null;

	// Remap unsupported raw audio formats from Telegram clients
	if (mimeHint === "audio/s16le" || mimeHint === "audio/x-wav") mimeHint = "audio/wav";
	if (mimeHint === "audio/m4a") mimeHint = "audio/mp4";

	return { fileId, mimeHint };
}

async function handleCommand(command, msg, env) {
	const chatId = msg.chat.id, threadId = msg.message_thread_id || "default";
	switch (command) {
		case "/start": {
			const pKey = getPersona(await env.CHAT_KV.get(`persona_${chatId}_${threadId}`));
			await telegram.sendMessage(chatId, threadId, `👋 Welcome. You are currently talking to <b>${personas[pKey].name}</b>.\n\nSend a message, voice note, photo, or document to begin.\n\n<b>Commands:</b>\n/persona — Choose who to talk to\n/mood — Interactive mood check-in\n/memories — View saved facts\n/clear — Fresh start\n/forget — Delete all memories`, env);
			return true;
		}
		case "/persona":
			await telegram.sendMessage(chatId, threadId, "Who would you like to speak with?", env, null, {
				inline_keyboard: [[
					{ text: "🎯 Tenon", callback_data: "set_persona_tenon" },
					{ text: "🌙 Nightfall", callback_data: "set_persona_nightfall" },
					{ text: "✨ Tribore", callback_data: "set_persona_tribore" }
				]]
			});
			return true;
		case "/clear":
			await env.CHAT_KV.delete(`chat_${chatId}_${threadId}`);
			await telegram.sendMessage(chatId, threadId, "🧹 Conversation history cleared. What is on your mind?", env);
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
				for (const [c, items] of Object.entries(factual)) { t += `<b>${c}</b>\n`; items.forEach(m => t += `• ${m.fact}\n`); t += "\n"; }
			}
			if (Object.keys(therapeutic).length) {
				t += "🔍 <b>Therapeutic Observations</b>\n\n";
				for (const [c, items] of Object.entries(therapeutic)) { t += `<b>${c}</b>\n`; items.forEach(m => { const star = m.importance_score >= 2 ? "⭐ " : ""; t += `• ${star}${m.fact}\n`; }); t += "\n"; }
			}
			await telegram.sendMessage(chatId, threadId, t + "<i>Use /forget to clear all.</i>", env);
			return true;
		}
		case "/forget":
			await telegram.sendMessage(chatId, threadId, "⚠️ Delete all saved memories?", env, null, { inline_keyboard: [[{ text: "✅ Yes, delete all", callback_data: "confirm_forget" }, { text: "❌ Cancel", callback_data: "cancel_forget" }]] });
			return true;
		case "/mood": {
			await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 7200 });
			await telegram.sendMessage(chatId, threadId,
				`🌙 <b>Nightfall here.</b> Let's do a mood check.\n\nWhere would you place yourself on the scale right now?\n\n🔴 <b>0-1: Severe Depression</b>\n<i>(Bleak, no movement, hopeless)</i>\n\n🟠 <b>2-3: Mild/Moderate</b>\n<i>(Struggle, slow thinking, anxious)</i>\n\n🟢 <b>4-6: Balanced</b>\n<i>(Good decisions, sociable, optimistic)</i>\n\n🟡 <b>7-8: Hypomania</b>\n<i>(Very productive, racing thoughts)</i>\n\n🔴 <b>9-10: Mania</b>\n<i>(Reckless, lost touch with reality)</i>`,
				env, null, {
					inline_keyboard: [
						[{ text: '🔴 0-1', callback_data: 'mood_score_1' }, { text: '🟠 2-3', callback_data: 'mood_score_3' }],
						[{ text: '🟢 4-6', callback_data: 'mood_score_5' }],
						[{ text: '🟡 7-8', callback_data: 'mood_score_7' }, { text: '🔴 9-10', callback_data: 'mood_score_9' }]
					]
				});
			return true;
		}
		default: return false;
	}
}

export async function handleMessage(msg, env) {
	const chatId = msg.chat.id, messageId = msg.message_id, threadId = msg.message_thread_id || "default";
	const replyToMessageId = msg.reply_to_message?.message_id || null;

	try {
		const firstName = msg.from.first_name || "User", userText = msg.text || msg.caption || "";
		const userIdentity = buildUserIdentity(msg);
		upsertUser(env, msg); // fire-and-forget — keeps users table fresh
		const cmdMatch = userText.match(/^\/(\w+)(@\w+)?/);
		if (cmdMatch && await handleCommand(`/${cmdMatch[1]}`, msg, env)) return;

		await telegram.sendChatAction(chatId, threadId, "typing", env);

		const [memCtx, semanticCtx, personaKey, rawHistory] = await Promise.all([
			memoryStore.getFormattedContext(env, chatId),
			vectorStore.getSemanticContext(env, chatId, userText),
			env.CHAT_KV.get(`persona_${chatId}_${threadId}`),
			env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: "json" })
		]);

		const activePersona = getPersona(personaKey);
		const hist = sanitizeHistory(rawHistory || []);

		// Model routing: owner gets Pro, everyone else gets Flash
		const isOwner = env.OWNER_ID && String(msg.from.id) === String(env.OWNER_ID);
		const textModel = isOwner ? PRIMARY_TEXT_MODEL : FALLBACK_TEXT_MODEL;

		// Health check-in auto-switch: if a health check-in is active, override to Nightfall
		const healthCheckin = isOwner ? await env.CHAT_KV.get(`health_checkin_active_${chatId}`) : null;
		const effectivePersona = healthCheckin ? 'nightfall' : activePersona;

		let replyContext = "";
		if (msg.reply_to_message) replyContext = `\n[User is replying to ${msg.reply_to_message.from?.first_name || "Someone"}: "${(msg.reply_to_message.text || msg.reply_to_message.caption || "").slice(0, 500)}"]\n`;

		const personaInstruction = personas[effectivePersona].instruction;
		const dynamicContext = `[Context] Current speaker: ${userIdentity} | London Time: ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })} | Unix: ${Math.floor(Date.now() / 1000)}${healthCheckin ? ` | HEALTH CHECK-IN MODE (${healthCheckin}): You are Nightfall conducting a ${healthCheckin} health check-in. Ask about mood, sleep, medication as appropriate for this time of day. Use the log_mood_entry tool to record data. Be warm but structured.` : ''}\n\nMEMORY:\n${memCtx}${semanticCtx}`;

		// Skip code execution when media is present (incompatible with audio/video inline data)
		// Also skip cache when media is present, because the cache has codeExecution baked in
		const hasMedia = !!getMediaFromMessage(msg);
		const cacheContext = hasMedia ? null : await setupCache(personaInstruction, FORMATTING_RULES, dynamicContext, env, textModel);
		const fullSysPrompt = `${personaInstruction}\n\n${MENTAL_HEALTH_DIRECTIVE}\n\n${SECOND_BRAIN_DIRECTIVE}\n\n${FORMATTING_RULES}\n${dynamicContext}`;
		const chat = await createChat(hist, fullSysPrompt, env, cacheContext, textModel, { skipCodeExecution: hasMedia });

		let userParts = [];
		if (cacheContext) {
			const dynamicPrefix = `${dynamicContext}\n\n`;
			if (replyContext) userParts.push({ text: dynamicPrefix + replyContext + (userText || "See attached media.") });
			else if (userText) userParts.push({ text: dynamicPrefix + userText });
			else userParts.push({ text: dynamicPrefix + "See attached media." });
		} else {
			if (replyContext) userParts.push({ text: replyContext + (userText || "See attached media.") });
			else if (userText) userParts.push({ text: userText });
		}

		let uploadedImageBase64 = null, uploadedImageMime = null;
		const media = getMediaFromMessage(msg);
		if (media) {
			try {
				const { base64, buffer, filePath, fileSize } = await telegram.downloadFile(media.fileId, env);

				if (shouldUseFilesAPI(fileSize, media.mimeHint)) {
					// Large file: pass raw buffer directly to Files API (no decoding)
					console.log(`📁 Large file (${(fileSize / 1024 / 1024).toFixed(1)}MB) → Files API`);
					const fileRef = await uploadToFilesAPI(buffer, media.mimeHint, filePath || 'upload', env);
					userParts.push({ fileData: { fileUri: fileRef.fileUri, mimeType: fileRef.mimeType } });
				} else {
					// Small file: inline base64
					userParts.push({ inlineData: { mimeType: media.mimeHint, data: base64 } });
				}

				if (media.mimeHint.startsWith("image/")) { uploadedImageBase64 = base64; uploadedImageMime = media.mimeHint; }
				if (userParts.length === 0 || (!userText && !replyContext && !cacheContext)) userParts.unshift({ text: "Describe or respond to this media." });
				// Store media in R2 (fire-and-forget) — pass raw buffer, no decoding
				if (env.MEDIA_BUCKET) {
					const mediaType = media.mimeHint.split('/')[0];
					mediaStore.storeMedia(env, chatId, mediaType, buffer, media.mimeHint, {
						messageId: String(messageId), filename: media.fileId,
					}).catch(e => console.error('R2 store error:', e.message));
				}
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `⚠️ Media error: ${e.message}`, env, messageId);
				if (userParts.length === 0) return;
			}
		}

		if (userParts.length === 0) return;

		// Generate a random draft_id for streaming (non-zero, unique per request)
		const draftId = Math.floor(Math.random() * 2147483646) + 1;
		let draftActive = false; // tracks if we've sent at least one draft update
		let lastDraftTime = 0;

		let isComplete = false, fullText = "", lastSentMsgId = null;
		let nextMessage = userParts;
		let isFirstPass = true;

		while (!isComplete) {
			// First pass with no tool calls: use streaming for animated text
			// Tool-calling passes: use non-streaming (need complete response for function call/response pairs)
			const useStreaming = isFirstPass;
			const stream = useStreaming
				? sendChatMessageStream(chat, nextMessage)
				: sendChatMessage(chat, nextMessage);

			let passText = "", toolCalls = [];

			for await (const chunk of stream) {
				if (chunk.type === 'text') {
					passText += chunk.text;
					fullText += chunk.text;

					// Stream draft to Telegram for animated text effect
					if (useStreaming) {
						const now = Date.now();
						if (now - lastDraftTime >= DRAFT_THROTTLE_MS && fullText.trim()) {
							// Strip incomplete HTML tags at the end to avoid parse errors
							const safeDraftText = fullText.replace(/<[^>]*$/, '');
							if (safeDraftText.trim()) {
								telegram.sendMessageDraft(chatId, threadId, draftId, safeDraftText, env, messageId);
								draftActive = true;
								lastDraftTime = now;
							}
						}
					}
				} else if (chunk.type === 'functionCall') {
					toolCalls.push(...chunk.calls);
				}
			}

			isFirstPass = false;

			if (toolCalls.length > 0) {
				await telegram.sendChatAction(chatId, threadId, "typing", env);

				let toolRes = [];
				for (const call of toolCalls) {
					const name = call.functionCall.name, args = call.functionCall.args;
					let result = { status: "success" };
					try {
						if (name === "send_voice_note") {
							await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
							const buf = await generateSpeech(args.text_to_speak, effectivePersona, env);
							await telegram.sendVoice(chatId, threadId, buf, env, messageId);
						} else if (name === "generate_image") {
							await telegram.sendChatAction(chatId, threadId, "upload_photo", env);
							console.log("🎨 Image gen started:", args.prompt?.slice(0, 80));
							const isEdit = args.edit_mode && uploadedImageBase64;
							const { imageBase64, mimeType, caption } = await generateImage(args.prompt, env, isEdit ? uploadedImageBase64 : null, isEdit ? uploadedImageMime : null);
							const { Buffer } = await import('node:buffer');
							const bytes = Buffer.from(imageBase64, 'base64');
							await env.CHAT_KV.put(`last_img_${chatId}_${threadId}`, JSON.stringify({ prompt: args.prompt }), { expirationTtl: 86400 });
							// Store generated image in R2
							if (env.MEDIA_BUCKET) {
								mediaStore.storeMedia(env, chatId, 'generated', imageBase64, mimeType, {
									prompt: args.prompt?.slice(0, 200), messageId: String(messageId),
								}).catch(e => console.error('R2 gen-image store error:', e.message));
							}
							await telegram.sendPhoto(chatId, threadId, bytes, mimeType, env, messageId, caption?.slice(0, 1024), { inline_keyboard: [[{ text: "🔄 Regenerate", callback_data: "img_regen" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]] });
							result = { status: "success", note: "Image sent" };
						} else {
							const tool = toolRegistry[name];
							if (tool) result = await tool.execute(args, env, {
								userId: msg.from.id, chatId, threadId, messageId, firstName, activePersona: effectivePersona,
								lastBotMessageId: lastSentMsgId, replyToMessageId
							});
						}
					} catch (e) {
						console.error(`Tool ${name} error:`, e.message);
						result = { status: "error", message: e.message };
					}
					toolRes.push({ functionResponse: { name, response: result } });
				}
				nextMessage = toolRes;
			} else {
				isComplete = true;
				if (fullText.trim()) {
					// Final message: send with HTML formatting + buttons (replaces the draft bubble)
					const btns = { inline_keyboard: [[{ text: "🔊 Voice", callback_data: "action_voice" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]] };
					const sent = await telegram.sendMessage(chatId, threadId, fullText, env, messageId, btns);
					lastSentMsgId = sent?.result?.message_id;
				}
			}
		}

		const rawSdkHistory = chat.getHistory();
		const cleanHistory = sanitizeHistory(rawSdkHistory).slice(-HISTORY_LENGTH);
		await env.CHAT_KV.put(`chat_${chatId}_${threadId}`, JSON.stringify(cleanHistory), { expirationTtl: HISTORY_TTL });

		// Index conversation in Vectorize for semantic recall (fire-and-forget)
		if (userText && fullText) {
			vectorStore.indexConversation(env, chatId, userText, fullText.slice(0, 200), messageId)
				.catch(e => console.error('Vectorize index error:', e.message));
		}

	} catch (err) {
		console.error("❌ handleMessage crash:", err.message, err.stack);
		try { await telegram.sendMessage(chatId, threadId, `⚠️ ${err.message?.slice(0, 150) || "Unknown error"}`, env, messageId); }
		catch (sendErr) { console.error("❌ Failed to send error msg:", sendErr.message); }
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
			await env.CHAT_KV.put(`persona_${chatId}_${threadId}`, key);
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			await telegram.sendChatAction(chatId, threadId, "typing", env);
			try {
				const greeting = await generateShortResponse(
					"The user just chose to talk to you. Greet them in 1-2 complete sentences in your distinct voice. Let them know you are here and ready.",
					personas[key].instruction,
					env
				);
				await telegram.sendMessage(chatId, threadId, greeting, env, null, null, "5159385139981059251");
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `You are now talking to <b>${personas[key].name}</b>.`, env);
			}
		}
	} else if (data === "confirm_forget") {
		await Promise.all([
			memoryStore.deleteAllMemories(env, chatId),
			vectorStore.deleteAllVectors(env, chatId),
		]);
		await telegram.editMessage(chatId, msgId, "🗑️ All memories deleted.", env);
	} else if (data === "cancel_forget") {
		await telegram.editMessage(chatId, msgId, "👍 Memories kept.", env);
	} else if (data === "action_voice") {
		const botText = callbackQuery.message.text || "";
		if (botText) {
			const voicePersona = getPersona(await env.CHAT_KV.get(`persona_${chatId}_${threadId}`));
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
			button.text = `☐  ${button.text.replace(/^✅\s+/, "")}`;
		} else {
			button.text = `✅  ${button.text.replace(/^☐\s+/, "")}`;
		}
		const newText = buildChecklistText(title, markup.inline_keyboard);
		await telegram.editMessage(chatId, msgId, newText, env, markup);
	} else if (data === "img_regen") {
		try {
			await telegram.sendChatAction(chatId, threadId, "upload_photo", env);
			const kvData = await env.CHAT_KV.get(`last_img_${chatId}_${threadId}`, { type: "json" });
			if (!kvData?.prompt) { await telegram.sendMessage(chatId, threadId, "⚠️ No previous prompt found.", env); return; }
			const { imageBase64, mimeType, caption } = await generateImage(kvData.prompt, env);
			const { Buffer } = await import('node:buffer');
			const bytes = Buffer.from(imageBase64, 'base64');
			await telegram.sendPhoto(chatId, threadId, bytes, mimeType, env, null, caption?.slice(0, 1024), { inline_keyboard: [[{ text: "🔄 Regenerate", callback_data: "img_regen" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]] });
		} catch (e) {
			console.error("Image regen error:", e.message);
			await telegram.sendMessage(chatId, threadId, `⚠️ Regeneration failed: ${e.message.slice(0, 100)}`, env);
		}
	}
	// ---- Mood/Medication callbacks from health check-ins ----
	else if (data.startsWith('mood_med_') || data.startsWith('mood_score_')) {
		const today = moodStore.todayLondon();
		await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
		await telegram.sendChatAction(chatId, threadId, "typing", env);

		let contextPrompt = "";

		// Handle Medication Callbacks
		if (data === 'mood_med_yes_morning') {
			await moodStore.upsertEntry(env, chatId, today, 'morning', { medication_taken: 1, medication_notes: 'Morning meds taken on time' });
			contextPrompt = "The user just confirmed they took their morning medication on time. Acknowledge this positively in one short sentence, then ask ONE natural follow-up question about how they slept last night. Do not ask anything else.";
		} else if (data === 'mood_med_no_morning') {
			await moodStore.upsertEntry(env, chatId, today, 'morning', { medication_taken: 0, medication_notes: 'Morning meds not taken at check-in' });
			contextPrompt = "The user just said they haven't taken their morning medication yet. Gently remind them not to skip it, then ask ONE natural follow-up question about how they slept last night.";
		} else if (data === 'mood_med_yes_midday') {
			await moodStore.upsertEntry(env, chatId, today, 'midday', { medication_taken: 1, medication_notes: 'ADHD + anxiety meds taken' });
			contextPrompt = "The user just confirmed they took their midday ADHD and anxiety medications. Acknowledge this, then ask ONE natural conversational question about how their day is going so far.";
		} else if (data === 'mood_med_partial_midday') {
			await moodStore.upsertEntry(env, chatId, today, 'midday', { medication_taken: 1, medication_notes: 'ADHD only, anxiety not taken' });
			contextPrompt = "The user just confirmed they took their ADHD medication, but not their anxiety medication. Acknowledge this, remind them anxiety meds are there if they need them, and ask ONE conversational question about how their day is going.";
		} else if (data === 'mood_med_no_midday') {
			await moodStore.upsertEntry(env, chatId, today, 'midday', { medication_taken: 0, medication_notes: 'Midday meds not taken' });
			contextPrompt = "The user hasn't taken their midday ADHD medication. Remind them gently that per NICE NG87 guidelines, taking it too late affects sleep, so they should take it soon. Then ask ONE conversational question about their day.";
		}
		// Handle Evening Mood Score Callbacks
		else if (data.startsWith('mood_score_')) {
			const score = parseInt(data.split('_')[2]);
			const entry = await moodStore.upsertEntry(env, chatId, today, 'evening', { mood_score: score });
			console.log(`📊 Evening mood logged: ${score}`);

			if (score <= 1) {
				contextPrompt = `The user just logged their mood as ${score}/10 — severe depression. This is a crisis-level score. Respond with genuine warmth and compassion. Mention that Samaritans (116 123) and SHOUT (text 85258) are available. Then ask ONE gentle question about what has been weighing on them. Do not overwhelm them.`;
			} else if (score >= 9) {
				contextPrompt = `The user just logged their mood as ${score}/10 — mania. This is clinically significant. Ask calmly whether they have slept, and whether they are making any big decisions right now. Gently suggest contacting their care team. Keep it to 2 sentences.`;
			} else {
				contextPrompt = `The user just logged their mood score as ${score}/10 (${entry.mood_label || 'unknown'}) on the Bipolar scale. Acknowledge this naturally and compassionately in 1-2 sentences. Then ask ONE natural follow-up question to continue the daily journal (e.g., ask about sleep, or what main activity they did today). Do NOT ask multiple questions at once.`;
			}
		}

		// Generate dynamic Nightfall response (+ mood art for evening scores)
		try {
			const sysPrompt = personas.nightfall.instruction + '\n\n' + MENTAL_HEALTH_DIRECTIVE;
			const response = await generateShortResponse(contextPrompt, sysPrompt, env);
			const aiMsg = `🌙 ${response}`;

			// For evening mood scores, generate abstract mood art as journal cover
			if (data.startsWith('mood_score_')) {
				await telegram.sendChatAction(chatId, threadId, 'upload_photo', env);
				const score = parseInt(data.split('_')[2]);
				const moodLabel = (moodStore.getMoodLabel(score) || 'balanced').replace(/_/g, ' ');
				const artPrompt = `An elegant, abstract minimalist digital art piece representing a human mood of "${moodLabel}". Atmospheric, evocative, beautiful colour palette matching the emotion. No text, no words, no letters.`;

				try {
					const { imageBase64, mimeType } = await generateImage(artPrompt, env);
					const { Buffer } = await import('node:buffer');
					const bytes = Buffer.from(imageBase64, 'base64');
					// Send art with Nightfall's response as caption
					await telegram.sendPhoto(chatId, threadId, bytes, mimeType, env, null, aiMsg);
				} catch (artErr) {
					console.error('Mood art failed:', artErr.message);
					await telegram.sendMessage(chatId, threadId, aiMsg, env);
				}
			} else {
				await telegram.sendMessage(chatId, threadId, aiMsg, env);
			}

			// Save to chat history so Nightfall remembers asking the question
			const histKey = `chat_${chatId}_${threadId}`;
			let hist = await env.CHAT_KV.get(histKey, { type: 'json' }) || [];
			hist.push({ role: 'model', parts: [{ text: aiMsg }] });
			if (hist.length > 24) hist = hist.slice(-24);
			await env.CHAT_KV.put(histKey, JSON.stringify(hist), { expirationTtl: 604800 });
		} catch (e) {
			console.error('Health callback AI error:', e.message);
			await telegram.sendMessage(chatId, threadId, '🌙 Noted. How are you feeling right now?', env);
		}
	}
}
