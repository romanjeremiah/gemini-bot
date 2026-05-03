import { personas, FORMATTING_RULES, MENTAL_HEALTH_DIRECTIVE, SECOND_BRAIN_DIRECTIVE } from '../config/personas';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';
import { createChat, sendChatMessage, sendChatMessageStream, generateImage, setupCache, PRIMARY_TEXT_MODEL, FALLBACK_TEXT_MODEL, FLASH_LITE_TEXT_MODEL, generateShortResponse, generateWithFallback, generateDeepResponse, StreamIdleError } from '../lib/ai/gemini';
import { routeMessage, createProvider } from '../ai/router';
import { detectComplexTask, isSimpleMessage } from '../ai/complexity';
import { CF_MODELS, MAX_TOOL_ROUNDS } from '../config/models';
import { buildSystemInstruction, ensurePersonaConfig } from '../services/persona';
import { getTimezone } from '../lib/timezone';
import { toolRegistry } from '../tools';
import * as telegram from '../lib/telegram';
import * as memoryStore from '../services/memoryStore';
import * as vectorStore from '../services/vectorStore';
import * as mediaStore from '../services/mediaStore';
import { uploadToFilesAPI, shouldUseFilesAPI } from '../services/filesApi';
import { upsertUser, buildUserIdentity, getStyleCard } from '../services/userStore';
import { generateSpeech } from '../lib/tts';
import { buildChecklistText } from '../tools/checklist';
import * as moodStore from '../services/moodStore';
import * as episodeStore from '../services/episodeStore';
import * as personaStore from '../services/personaStore';
import { safeLike } from '../lib/db';
import { getAllSchedules, setSchedule, resetSchedule } from '../config/schedules';
import { log } from '../lib/logger';

const HISTORY_LENGTH = 24;
const HISTORY_TTL = 604800;
const DRAFT_THROTTLE_MS = 500;

/** Strip leaked thinking/internal reasoning from model output */
function stripLeakedThoughts(text) {
	if (!text) return text;
	return text
		// Remove ALL [bracketed internal actions/thoughts] — italic or not
		.replace(/<i>\s*\[[^\]]{0,300}\]\s*<\/i>/gi, '')
		.replace(/\[(?:Noticing|Thinking|Considering|Reflecting|Observing|Planning|Analyzing|Processing|Noting|Recalling|Checking|Looking|Adjusting|Scanning|Reviewing|Connecting|Sensing|Reading|Pulling|Searching|Querying|Loading|Fetching|Parsing)[^\]]{0,300}\]/gi, '')
		// Remove ⚙️ Computing... Result: ... lines
		.replace(/⚙️\s*Computing[^\n]*\n?/g, '')
		.replace(/^Result:\s*.*?timestamp:\s*\d+\s*$/gm, '')
		// Remove ACTION PLAN leaks
		.replace(/ACTION PLAN[^\n]*(?:\n[-•*][^\n]*)*/g, '')
		// Remove PROCEDURAL MEMORY leaks
		.replace(/PROCEDURAL MEMORY[^\n]*(?:\n[-•*][^\n]*)*/g, '')
		// Clean up resulting double newlines
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Split long text into chunks at paragraph boundaries, preserving HTML tag state across chunks */
function splitMessage(text, maxLen = 3900) {
	if (text.length <= maxLen) return [text];

	const chunks = [];
	let remaining = text;
	let openTags = []; // stack of tags open at the end of previous chunk

	while (remaining.length > 0) {
		// Re-open tags from previous chunk
		const reopenPrefix = openTags.map(t => `<${t}>`).join('');
		const effectiveMax = maxLen - reopenPrefix.length;
		let piece = reopenPrefix + remaining;

		if (piece.length <= maxLen) {
			chunks.push(piece);
			break;
		}

		// Find split point at paragraph boundary
		let splitIdx = piece.lastIndexOf('\n\n', maxLen);
		if (splitIdx < maxLen * 0.3) splitIdx = piece.lastIndexOf('\n', maxLen);
		if (splitIdx < maxLen * 0.3) splitIdx = maxLen;

		let chunk = piece.slice(0, splitIdx).trim();
		remaining = piece.slice(splitIdx).trim();
		// Remove the reopenPrefix from remaining since we sliced from `piece`
		if (reopenPrefix && remaining.startsWith(reopenPrefix)) {
			remaining = remaining.slice(reopenPrefix.length);
		}

		// Track open/close tags in this chunk to know what to reopen next
		openTags = getOpenTags(chunk);

		// Close any tags left open at end of this chunk
		const closers = [...openTags].reverse().map(t => {
			const tagName = t.split(/\s/)[0]; // handle <blockquote expandable>
			return `</${tagName}>`;
		}).join('');
		chunk += closers;

		chunks.push(chunk);
	}
	return chunks;
}

/** Parse HTML to find which tags are still open at the end of a string */
function getOpenTags(html) {
	const stack = [];
	const tagRegex = /<\/?([a-z0-9-]+)(?:\s+[^>]*?)?>/gi;
	let match;
	while ((match = tagRegex.exec(html)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();
		const isClosing = fullTag.startsWith('</');
		if (fullTag.endsWith('/>')) continue;
		if (isClosing) {
			if (stack.length > 0 && stack[stack.length - 1].split(/\s/)[0] === tagName) stack.pop();
		} else {
			// Store full opening tag content (e.g. "blockquote expandable")
			const inner = fullTag.slice(1, -1).trim(); // strip < >
			stack.push(inner);
		}
	}
	return stack;
}

/**
 * Send a long message as multiple chunks with rate-limit-safe delays.
 * Returns the message_id of the last sent message.
 */
async function sendLongMessage(chatId, threadId, text, env, replyId = null, finalMarkup = null, bizConnId = null) {
	const chunks = splitMessage(text, 3900);
	let lastMsgId = null;
	for (let i = 0; i < chunks.length; i++) {
		const isFirst = i === 0;
		const isLast = i === chunks.length - 1;
		// Small delay between chunks to avoid Telegram rate limits (30 msg/sec per chat)
		if (i > 0) await new Promise(r => setTimeout(r, 120));
		const sent = await telegram.sendMessage(
			chatId, threadId, chunks[i], env,
			isFirst ? replyId : null,
			isLast ? finalMarkup : undefined,
			null, null, bizConnId
		);
		if (sent?.result?.message_id) lastMsgId = sent.result.message_id;
	}
	return lastMsgId;
}

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework'];

// Re-export complexity helpers from ai/complexity.js for backwards compatibility.
// src/index.js imports detectComplexTask from './bot/handlers' for queue routing,
// and external test files may reference these names. The real definitions live in
// ../ai/complexity — routing-layer code should import from there directly.
export { detectComplexTask, isSimpleMessage } from '../ai/complexity';

// Silent Observation: Xaridotis quietly reflects on conversations to learn about the user
// implicitly. Runs in the background after substantive exchanges. Throttled to max 5/day.
async function silentObservation(env, userId, chatId, userText, botResponse) {
	// Throttle: max 5 observations per day
	const today = new Date().toISOString().split('T')[0];
	const countKey = `observation_count_${userId}_${today}`;
	const count = parseInt(await env.CHAT_KV.get(countKey) || '0');
	if (count >= 5) return;

	try {
		// Use Cloudflare AI (free) instead of Gemini for background observation
		const { extractObservation } = await import('../services/cfAi');
		const response = await extractObservation(env, userText, botResponse);

		if (response && response.includes('OBSERVATION:')) {
			const obsMatch = response.match(/OBSERVATION:\s*(.+)/);
			if (obsMatch && obsMatch[1].trim().length > 10) {
				const observation = obsMatch[1].trim();
				await memoryStore.saveMemory(env, userId, 'insight', `Implicit: ${observation}`, 1);
				await env.CHAT_KV.put(countKey, String(count + 1), { expirationTtl: 86400 });
				log.info('silent_observation', { userId, observation: observation.slice(0, 80) });
			}
		}

		// GraphRAG: extract relational triples (Subject | Predicate | Object)
		if (response) {
			const tripleMatches = response.matchAll(/TRIPLE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)/g);
			for (const match of tripleMatches) {
				const [, subject, predicate, object] = match;
				const triple = `${subject.trim()} | ${predicate.trim()} | ${object.trim()}`;
				// Avoid duplicates: check if this triple already exists
				const existing = await env.DB.prepare(
					`SELECT id FROM memories WHERE user_id = ? AND category = 'triple' AND fact = ? LIMIT 1`
				).bind(userId, triple).first();
				if (!existing) {
					await memoryStore.saveMemory(env, userId, 'triple', triple, 1);
					log.info('triple_extracted', { userId, triple });
				}
			}
		}

		// Auto-episode detection: was this conversation emotionally significant?
		const isEmotional = /\b(anxious|depressed|panic|overwhelm|scared|lonely|empty|hopeless|angry|frustrated|sad|grief|trigger|suicid|self.?harm|crying|breakdown|manic|racing|numb)\b/i.test(userText);
		const isBreakthrough = /\b(realise|realize|never thought|makes sense|finally understand|clicked|ah|insight|pattern|see it now)\b/i.test(userText);

		if (isEmotional || isBreakthrough) {
			try {
				const episodeResponse = await generateShortResponse(
					`You just had this emotionally significant exchange:
USER: ${userText.slice(0, 400)}
YOU: ${botResponse.slice(0, 400)}

Create a structured episode record. Respond with ONLY valid JSON (no markdown):
{"type":"${isBreakthrough ? 'breakthrough' : 'conversation'}","trigger":"what prompted this (1 sentence)","emotions":["emotion1","emotion2"],"intervention":"what you did/suggested (1 sentence)","outcome":"positive|negative|neutral|pending","lesson":"what to remember for next time (1 sentence)"}`,
					'You are an episode logger. Return only valid JSON, no explanation.', env
				);
				if (episodeResponse) {
					const cleaned = episodeResponse.replace(/```json|```/g, '').trim();
					const ep = JSON.parse(cleaned);
					await episodeStore.saveEpisode(env, userId, {
						type: ep.type || 'conversation',
						trigger: ep.trigger,
						emotions: ep.emotions || [],
						intervention: ep.intervention,
						outcome: ep.outcome,
						lesson: ep.lesson,
					});
					log.info('auto_episode_saved', { userId, type: ep.type, trigger: ep.trigger?.slice(0, 60) });
				}
			} catch { /* episode creation is best-effort */ }
		}

		// GraphRAG: extract relationship triples from the conversation
		try {
			const tripleResponse = await generateShortResponse(
				`Extract factual relationship triples from this exchange. Return ONLY valid JSON array (no markdown).
USER: ${userText.slice(0, 300)}
ASSISTANT: ${botResponse.slice(0, 200)}

Format: [{"subject":"X","predicate":"Y","object":"Z"}]
Examples: [{"subject":"Roman","predicate":"enjoys","object":"drone videography"},{"subject":"coffee","predicate":"is","object":"stimulant"}]
Only extract concrete, factual relationships. If nothing new, return [].`,
				'You extract knowledge graph triples. Return only valid JSON array.', env
			);
			if (tripleResponse && tripleResponse.startsWith('[')) {
				const triples = JSON.parse(tripleResponse.replace(/```json|```/g, '').trim());
				const { saveTriple } = await import('../services/knowledgeGraph');
				for (const t of triples.slice(0, 5)) {
					if (t.subject && t.predicate && t.object) {
						await saveTriple(env, userId, t.subject, t.predicate, t.object, null, 'conversation');
					}
				}
				if (triples.length) log.info('graph_triples_extracted', { userId, count: triples.length });
			}
		} catch { /* triple extraction is best-effort */ }

	} catch { /* silent fail - this is background enrichment, not critical */ }
}

// Lightweight weather fetch for ambient context (cached 30min in KV)
async function getWeatherContext(env) {
	try {
		const cached = await env.CHAT_KV.get('weather_london');
		if (cached) return cached;
		const res = await fetch('https://wttr.in/London?format=%C+%t+%h&lang=en');
		if (!res.ok) return '';
		const weather = (await res.text()).trim();
		const ctx = `London Weather: ${weather}`;
		await env.CHAT_KV.put('weather_london', ctx, { expirationTtl: 1800 });
		return ctx;
	} catch { return ''; }
}

// Helper: build a dynamic journal roadmap by checking what's missing in today's DB entry
async function getCheckinRoadmap(env, userId) {
	const todayLondon = moodStore.todayLondon();
	const entry = await moodStore.getEntry(env, userId, todayLondon, 'evening');
	const missing = [];
	if (!entry || entry.mood_score === null) missing.push('mood score (0-10)');
	if (!entry || entry.sleep_hours === null) missing.push('sleep hours and quality');
	if (!entry || !entry.emotions || entry.emotions === '[]' || entry.emotions === 'null') missing.push('specific emotions from the emotions library');
	if (!entry || !entry.activities || entry.activities === '[]' || entry.activities === 'null') missing.push('activities done today');
	if (!entry || !entry.photo_r2_key) missing.push('a photo of the day');
	if (!entry || !entry.note) missing.push('any final thoughts or notes');

	if (missing.length > 0) {
		return `JOURNAL ROADMAP: Still missing: ${missing.join(', ')}.
CONTEXTUAL AWARENESS: First, evaluate the user's latest message. If they are talking about an unrelated task (groceries, reminders, coding, general chat), DO NOT ask a mood check question. Fulfill their request first. You can add a brief note that the check-in can continue later.
DEEP CHECK-IN: If they ARE engaging with the check-in, use your emotional intelligence to ask ONE detailed, natural question to gather the NEXT missing piece. Explain WHY you are asking when appropriate (e.g., the clinical link between sleep and their mood score).
POLLS: You are encouraged to use the send_poll tool when asking about emotions or activities, offering structured options from the library to reduce cognitive load.`;
	}
	return 'JOURNAL ROADMAP: All data collected. Warmly wrap up the check-in and summarise the day.';
}

function getPersona(key) {
	// Resolve to a valid persona key. Custom personas fall back to their base.
	if (personas[key]) return key;
	return 'xaridotis';
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
			await telegram.sendMessage(chatId, threadId, `Hey. I am <b>Xaridotis</b>.\n\nSend a message, voice note, photo, or document to begin.\n\n<b>Commands:</b>\n/mood — Interactive mood check-in\n/listen — Deep listening mode\n/architect — Architecture review\n/schedule — View schedules\n/memories — View saved facts\n/clear — Fresh start\n/forget — Delete all memories`, env);
			return true;
		}
		case "/persona": {
			const allPersonas = await personaStore.getAllPersonas(env, msg.from.id);
			if (!allPersonas.length) {
				await telegram.sendMessage(chatId, threadId, "No personas configured. Send a message to get started.", env);
				return true;
			}
			const currentKey = await env.CHAT_KV.get(`persona_${chatId}_${threadId}`) || 'xaridotis';
			let text = '<b>Available Personas</b>\n\n';
			for (const p of allPersonas) {
				const active = p.persona_key === currentKey ? ' (active)' : '';
				const custom = p.is_custom ? ' [custom]' : '';
				text += `${p.display_name || p.persona_key}${active}${custom}\n`;
				text += `<i>${p.tone} · ${p.formality} · ${p.voice_name || 'default voice'}</i>\n\n`;
			}
			const buttons = allPersonas.map(p => ({
				text: `${p.persona_key === currentKey ? '● ' : ''}${p.display_name || p.persona_key}`,
				callback_data: `set_persona_${p.persona_key}`
			}));
			// Arrange buttons in rows of 2
			const rows = [];
			for (let i = 0; i < buttons.length; i += 2) {
				rows.push(buttons.slice(i, i + 2));
			}
			await telegram.sendMessage(chatId, threadId, text, env, null, { inline_keyboard: rows });
			return true;
		}
		case "/clear":
			await env.CHAT_KV.delete(`chat_${chatId}_${threadId}`);
			await telegram.sendMessage(chatId, threadId, "🧹 Conversation history cleared. What is on your mind?", env);
			return true;
		case "/memories": {
			const mems = await memoryStore.getMemories(env, msg.from.id, 40);
			if (!mems.length) { await telegram.sendMessage(chatId, threadId, "📭 No memories saved.", env); return true; }
			const factual = {}, therapeutic = {};
			for (const m of mems) {
				const target = THERAPEUTIC_CATEGORIES.includes(m.category) ? therapeutic : factual;
				if (!target[m.category]) target[m.category] = [];
				target[m.category].push(m);
			}
			let t = "🧠 <b>Saved Memories</b> (" + mems.length + " total)\n\n";
			if (Object.keys(factual).length) {
				for (const [c, items] of Object.entries(factual)) {
					t += `<b>${c}</b> (${items.length})\n`;
					items.slice(0, 5).forEach(m => t += `• ${m.fact.slice(0, 120)}${m.fact.length > 120 ? '...' : ''}\n`);
					if (items.length > 5) t += `<i>  ...and ${items.length - 5} more</i>\n`;
					t += "\n";
				}
			}
			if (Object.keys(therapeutic).length) {
				t += "🔍 <b>Therapeutic Observations</b>\n\n";
				for (const [c, items] of Object.entries(therapeutic)) {
					t += `<b>${c}</b> (${items.length})\n`;
					items.slice(0, 3).forEach(m => { const star = m.importance_score >= 2 ? "⭐ " : ""; t += `• ${star}${m.fact.slice(0, 120)}${m.fact.length > 120 ? '...' : ''}\n`; });
					if (items.length > 3) t += `<i>  ...and ${items.length - 3} more</i>\n`;
					t += "\n";
				}
			}
			const footer = "<i>Use /forget to clear all.</i>";
			await sendLongMessage(chatId, threadId, t + footer, env);
			return true;
		}
		case "/forget":
			await telegram.sendMessage(chatId, threadId, "⚠️ Delete all saved memories?", env, null, { inline_keyboard: [[{ text: "✅ Yes, delete all", callback_data: "confirm_forget", style: "danger" }, { text: "❌ Cancel", callback_data: "cancel_forget", style: "success" }]] });
			return true;
		case "/model":
			await telegram.sendMessage(chatId, threadId,
				"<b>AI Model Selection</b>\n\nChoose which brain to use for this chat:\n\n🚀 <b>Pro</b>: Deepest reasoning, best at complex tasks.\n⚡ <b>Flash</b>: Faster responses, efficient for simple chat.\n🔄 <b>Auto</b>: Default logic (Owner gets Pro).",
				env, null, {
					inline_keyboard: [
						[
							{ text: "🚀 Pro", callback_data: "set_model_pro" },
							{ text: "⚡ Flash", callback_data: "set_model_flash" }
						],
						[{ text: "🔄 Reset to Auto", callback_data: "set_model_auto" }]
					]
				});
			return true;
		case "/listen":
			await env.CHAT_KV.put(`listening_mode_${chatId}`, '1', { expirationTtl: 86400 });
			await env.CHAT_KV.delete(`listen_buffer_${chatId}`);
			await telegram.sendMessage(chatId, threadId, "<b>Deep Listening Mode</b>\n\nTake all the space you need. Send as many messages or voice notes as you want without interruption.\n\nType /done when you are finished and I will synthesise everything.", env);
			return true;
		case "/done": {
			const listening = await env.CHAT_KV.get(`listening_mode_${chatId}`);
			if (!listening) {
				await telegram.sendMessage(chatId, threadId, "We are not in listening mode. Use /listen to start.", env);
				return true;
			}
			await env.CHAT_KV.delete(`listening_mode_${chatId}`);
			const bufferStr = await env.CHAT_KV.get(`listen_buffer_${chatId}`) || '[]';
			const buffer = JSON.parse(bufferStr);
			await env.CHAT_KV.delete(`listen_buffer_${chatId}`);

			if (buffer.length === 0) {
				await telegram.sendMessage(chatId, threadId, "You did not say anything, but I am always here when you need me.", env);
				return true;
			}

			await telegram.sendMessage(chatId, threadId, "<i>[Synthesising your thoughts...]</i>", env);
			const dumpText = `I have just completed a Deep Listening brain dump. Here are my raw, unedited thoughts across ${buffer.length} messages:\n\n${buffer.join('\n\n')}\n\nPlease synthesise this. Identify core themes, active schemas, or actionable steps. Proactively use your tools to save any important patterns or ideas to my memory, then give me a cohesive, compassionate response.`;
			const fakeMsg = { ...msg, text: dumpText, caption: undefined };
			return handleMessage(fakeMsg, env);
		}
		case "/mood": {
			await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 1800 });

			// Send mood poll (0-10 bipolar scale). Uses the canonical MOOD_POLL_OPTIONS
			// imported from config/moodScale.js — same text as the scheduled evening poll.
			const pollRes = await telegram.sendPoll(chatId, threadId,
				'How do you feel right now?',
				MOOD_POLL_OPTIONS,
				env, { is_anonymous: false }
			);

			if (pollRes?.ok) {
				const pollId = pollRes.result.poll.id;
				await env.CHAT_KV.put(`mood_poll_${pollId}`, JSON.stringify({
					chatId, threadId, type: 'mood_checkin', sentAt: Date.now()
				}), { expirationTtl: 86400 });
			}
			return true;
		}
		case "/timezone": {
			const tz = (msg.text || '').replace('/timezone', '').trim();
			if (!tz) {
				// Read from canonical per-chat key. Fallback to UTC matches the
				// default in src/lib/timezone.js when nothing is stored.
				const current = await getTimezone(chatId, env);
				await telegram.sendMessage(chatId, threadId,
					`Current timezone: <b>${current}</b>\n\nTo change: <code>/timezone America/New_York</code>\n\nOr send your location (paperclip → Location, or use /setlocation) and I'll detect it automatically.`, env);
				return true;
			}
			// Validate timezone
			try {
				new Date().toLocaleString('en-US', { timeZone: tz });
				// Write to per-chat key (canonical). Old global `user_timezone`
				// key is left in place for now; migration cleanup in step 6 below.
				await env.CHAT_KV.put(`timezone_${chatId}`, tz);
				await telegram.sendMessage(chatId, threadId, `Timezone updated to <b>${tz}</b>. All check-ins and schedules will use this timezone.`, env);
			} catch {
				await telegram.sendMessage(chatId, threadId, `Invalid timezone: "${tz}". Use IANA format, e.g. <code>Europe/London</code>, <code>America/New_York</code>, <code>Asia/Tokyo</code>`, env);
			}
			return true;
		}
		case "/setlocation": {
			// Send a one-shot reply keyboard with a "Share location" button.
			// The user taps once, location arrives at the location handler in
			// src/index.js, which calls Google Time Zone API and updates the
			// per-chat timezone. The keyboard is removed automatically after use
			// via one_time_keyboard:true.
			const replyMarkup = {
				keyboard: [[{ text: '📍 Share my location', request_location: true }]],
				one_time_keyboard: true,
				resize_keyboard: true,
			};
			await telegram.sendMessage(chatId, threadId,
				'Tap below to share your current location. I\'ll detect the timezone and use it for all schedules.',
				env, null, replyMarkup);
			return true;
		}
		case "/firecron": {
			// Owner-only debug command. Bypasses time-window and lock checks and
			// queues a scheduled task immediately so we can trace where the chain
			// breaks. Useful when scheduled jobs silently fail.
			//
			// Usage:
			//   /firecron morning              → health_checkin (morning)
			//   /firecron midday               → health_checkin (midday)
			//   /firecron evening              → health_checkin (evening) — text greeting
			//   /firecron mood_poll            → mood poll (the 0-10 bipolar scale)
			//   /firecron med_nudge            → medication follow-up
			//   /firecron spontaneous_outreach → random knowledge / proactive outreach
			//   /firecron queue_test           → bare consumer test
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const arg = (msg.text || '').replace('/firecron', '').trim().toLowerCase();
			const validPeriods = ['morning', 'midday', 'evening'];
			const validTypes = ['mood_poll', 'med_nudge', 'spontaneous_outreach', 'queue_test'];

			let queueMsg = null;
			if (validPeriods.includes(arg)) {
				queueMsg = { type: 'health_checkin', period: arg, chatId };
			} else if (validTypes.includes(arg)) {
				queueMsg = { type: arg, chatId };
			} else {
				await telegram.sendMessage(chatId, threadId,
					`Usage: <code>/firecron &lt;type&gt;</code>\n\n` +
					`Valid: <code>morning</code>, <code>midday</code>, <code>evening</code>, ` +
					`<code>mood_poll</code>, <code>med_nudge</code>, ` +
					`<code>spontaneous_outreach</code>, <code>queue_test</code>`,
					env);
				return true;
			}

			if (!env.TASK_QUEUE) {
				await telegram.sendMessage(chatId, threadId,
					'⚠️ TASK_QUEUE binding not available — cannot queue task.', env);
				return true;
			}

			try {
				await env.TASK_QUEUE.send(queueMsg);
				await telegram.sendMessage(chatId, threadId,
					`✅ Queued: <code>${JSON.stringify(queueMsg)}</code>\n\nWatch <code>wrangler tail</code> for the consumer trace.`,
					env);
			} catch (err) {
				await telegram.sendMessage(chatId, threadId,
					`❌ Queue send failed: <code>${(err.message || '').slice(0, 200)}</code>`, env);
			}
			return true;
		}
		case "/personastate": {
			// Owner-only debug command. Show what evolved_traits and communication_notes
			// have been learned for the active persona. NULL means the evolution loop
			// has either not run yet or had no high-confidence signals.
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const row = await env.DB.prepare(
				"SELECT persona_key, display_name, evolved_traits, communication_notes, updated_at FROM persona_config WHERE user_id = ? ORDER BY updated_at DESC"
			).bind(msg.from.id).all();
			const rows = row?.results || [];
			if (!rows.length) {
				await telegram.sendMessage(chatId, threadId, "No persona_config rows found.", env);
				return true;
			}
			let text = "<b>Persona State</b>\n\n";
			for (const r of rows) {
				text += `<b>${r.display_name || r.persona_key}</b> <i>(${r.persona_key})</i>\n`;
				text += `Updated: ${r.updated_at || 'never'}\n\n`;
				text += `<u>Communication notes:</u>\n<code>${r.communication_notes || '(none)'}</code>\n\n`;
				text += `<u>Evolved traits:</u>\n<code>${r.evolved_traits || '(none)'}</code>\n\n`;
			}
			await sendLongMessage(chatId, threadId, text, env);
			return true;
		}
		case "/evolvepersona": {
			// Owner-only debug command. Manually trigger the persona evolution loop
			// for one-shot validation. Bypasses the daily 04:00 cron schedule.
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			await telegram.sendMessage(chatId, threadId, "🌱 Running persona evolution... check <code>/personastate</code> after.", env);
			try {
				const { evolvePersona } = await import('../services/personaEvolution');
				await evolvePersona(env, msg.from.id);
				await telegram.sendMessage(chatId, threadId, "✅ Evolution pass complete. Run <code>/personastate</code> to view.", env);
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `❌ Failed: <code>${(e.message || '').slice(0, 200)}</code>`, env);
			}
			return true;
		}
		case "/consolidate": {
			// Owner-only debug command. Manually trigger memory consolidation now
			// for one-shot cleanup of the current memory pile (e.g. dropping 63
			// memories down to ~20 cleaner ones). Same logic the auto-trigger uses;
			// this just bypasses the count/throttle thresholds.
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const userId = msg.from.id;
			const beforeRow = await env.DB.prepare(
				'SELECT COUNT(*) AS n FROM memories WHERE user_id = ?'
			).bind(userId).first();
			const before = beforeRow?.n || 0;

			await telegram.sendMessage(chatId, threadId,
				`🧠 Consolidating <b>${before}</b> memories... this may take 10-30 seconds.`, env);

			try {
				await memoryStore.consolidateMemories(env, userId);
				const afterRow = await env.DB.prepare(
					'SELECT COUNT(*) AS n FROM memories WHERE user_id = ?'
				).bind(userId).first();
				const after = afterRow?.n || 0;
				await env.CHAT_KV.put(`memory_consolidation_last_${userId}`, String(Date.now()), { expirationTtl: 86400 * 7 });
				await telegram.sendMessage(chatId, threadId,
					`✅ Consolidation done.\n\n<b>Before:</b> ${before} memories\n<b>After:</b> ${after} memories\n<b>Reduction:</b> ${before - after} (${before > 0 ? Math.round((before - after) / before * 100) : 0}%)\n\n<i>Note: Vectorize index entries for deleted memories will be cleaned up by indexed retrieval misses over time.</i>`,
					env);
			} catch (e) {
				await telegram.sendMessage(chatId, threadId,
					`❌ Consolidation failed: <code>${(e.message || '').slice(0, 200)}</code>`, env);
			}
			return true;
		}
		case "/testpoll": {
			// Test whether poll_answer webhooks are received
			const pollRes = await telegram.sendPoll(chatId, threadId,
				'Poll Test: How do you feel right now?',
				[
					'0-1: Bleak, no hope',
					'2-3: Struggling, anxious',
					'4-6: Balanced, steady',
					'7-8: Buzzing, racing',
					'9-10: Out of control'
				],
				env, { is_anonymous: false }
			);
			if (pollRes?.ok) {
				const pollId = pollRes.result.poll.id;
				await env.CHAT_KV.put(`poll_test_${pollId}`, JSON.stringify({ chatId, threadId, type: 'mood_test' }), { expirationTtl: 3600 });
				log.info('test_poll_sent', { chatId, pollId });
			}
			return true;
		}
		case "/tagmode": {
			// Owner-only debug command. Tests the conversation-mode tagger in
			// isolation so we can validate Gemma's classifications BEFORE we
			// splice the tagger into every prompt. Outputs the chosen mode,
			// confidence layer (heuristic agreement check), source provider,
			// and round-trip latency.
			//
			// Usage: /tagmode <message to classify>
			// Example: /tagmode he's still ignoring me
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const sample = (msg.text || '').replace('/tagmode', '').trim();
			if (!sample) {
				await telegram.sendMessage(chatId, threadId,
					'Usage: <code>/tagmode &lt;message&gt;</code>\n\n' +
					'Examples:\n' +
					'• <code>/tagmode he is still ignoring me</code>\n' +
					'• <code>/tagmode why does this keep happening</code>\n' +
					'• <code>/tagmode remind me at 9am tomorrow</code>\n' +
					'• <code>/tagmode I cannot go on like this</code>',
					env);
				return true;
			}

			// Use real recent history from this chat so the tagger sees real context.
			// Falls back to empty array if nothing stored yet.
			const rawHistory = await env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: 'json' }) || [];
			const recentHistory = sanitizeHistory(rawHistory).slice(-4);

			const t0 = Date.now();
			const { tagConversationMode } = await import('../services/cfAi');
			const result = await tagConversationMode(env, sample, recentHistory);
			const elapsed = Date.now() - t0;

			// Pretty-print provider chain status. The user wants to know which tier
			// fired, so we surface the source explicitly. 'heuristic-only' means all
			// four AI providers failed — that is itself useful diagnostic data.
			const sourceLabel = {
				'gemma-4': '🟢 Gemma 4 (CF AI)',
				'gemini-flash': '🟡 Gemini Flash (fallback)',
				'gemini-flash-lite': '🟡 Gemini Flash-Lite (fallback)',
				'llama-8b': '🔵 Llama 3.1 8B (Tier 1)',
				'heuristic-only': '🔴 HEURISTIC FLOOR (all providers failed)',
				'default-empty': '⚪ Default (empty input)',
			}[result.source] || result.source;

			const confEmoji = { high: '✅', medium: '🟡', low: '⚠️' }[result.confidence] || '?';

			const report =
				`<b>Tag Mode Test</b>\n\n` +
				`<b>Input:</b> <i>${sample.slice(0, 200).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</i>\n\n` +
				`<b>Mode:</b> <code>${result.mode}</code>\n` +
				`<b>Confidence:</b> ${confEmoji} <code>${result.confidence}</code>\n` +
				`<b>Source:</b> ${sourceLabel}\n` +
				`<b>Latency:</b> ${elapsed}ms\n` +
				`<b>History context:</b> ${recentHistory.length} turn(s)\n\n` +
				`<i>Confidence comes from heuristic agreement — high = surface features support the model pick, low = features point a different direction.</i>`;

			await telegram.sendMessage(chatId, threadId, report, env);
			log.info('tagmode_test', {
				sample: sample.slice(0, 80),
				mode: result.mode,
				confidence: result.confidence,
				source: result.source,
				latency_ms: elapsed,
			});
			return true;
		}
		case "/researchfull": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const searchTopic = (msg.text || '').replace('/researchfull', '').trim();
			try {
				// Find research references in D1
				let query = `SELECT fact FROM memories WHERE user_id = ? AND category = 'research_ref'`;
				const params = [msg.from.id];
				if (searchTopic) {
					query += ` AND fact LIKE ?`;
					params.push(`%${safeLike(searchTopic)}%`);
				}
				query += ` ORDER BY created_at DESC LIMIT 5`;

				const { results } = await env.DB.prepare(query).bind(...params).all();
				if (!results?.length) {
					await telegram.sendMessage(chatId, threadId, searchTopic
						? `No research found matching "${searchTopic}". Try <code>/researchfull</code> to see all.`
						: 'No research reports saved yet.', env);
					return true;
				}

				if (!searchTopic && results.length > 1) {
					// Show list for selection
					let text = '<b>Available Research Reports</b>\n\nSpecify a topic to read the full report:\n\n';
					for (const r of results) {
						const topicMatch = r.fact.match(/Topic:\s*(.+)$/);
						const topic = topicMatch ? topicMatch[1] : 'Unknown';
						text += `<code>/researchfull ${topic.slice(0, 40)}</code>\n`;
					}
					await telegram.sendMessage(chatId, threadId, text, env);
					return true;
				}

				// Get the R2 key from the first match
				const keyMatch = results[0].fact.match(/\[R2:([^\]]+)\]/);
				if (!keyMatch || !env.MEDIA_BUCKET) {
					await telegram.sendMessage(chatId, threadId, 'Full report not available (R2 storage reference missing).', env);
					return true;
				}

				const obj = await env.MEDIA_BUCKET.get(keyMatch[1]);
				if (!obj) {
					await telegram.sendMessage(chatId, threadId, 'Full report not found in storage. It may have been cleaned up.', env);
					return true;
				}

				const fullReport = await obj.text();
				const topicLabel = results[0].fact.match(/Topic:\s*(.+)$/)?.[1] || 'Research';
				const formatted = `<b>Full Research Report</b>\n<i>${topicLabel}</i>\n\n<blockquote expandable>${fullReport}</blockquote>`;
				await sendLongMessage(chatId, threadId, formatted, env);
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `Error: ${e.message?.slice(0, 100)}`, env);
			}
			return true;
		}
		case "/researchhistory": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			try {
				const { results } = await env.DB.prepare(
					`SELECT fact, category, created_at FROM memories WHERE user_id = ? AND fact LIKE 'Deep Research%' ORDER BY created_at DESC LIMIT 10`
				).bind(msg.from.id).all();

				if (!results?.length) {
					await telegram.sendMessage(chatId, threadId, "No deep research results found yet. Use <code>/research your topic</code> to start one.", env);
					return true;
				}

				let text = `<b>Deep Research History</b> (${results.length} results)\n\n`;
				const userTz = await getTimezone(chatId, env);
				for (const r of results) {
					const date = new Date(r.created_at + 'Z').toLocaleDateString('en-GB', { timeZone: userTz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
					const topicMatch = r.fact.match(/^Deep Research \(([^)]+)\):/);
					const topic = topicMatch ? topicMatch[1] : 'Unknown';
					const summary = r.fact.replace(/^Deep Research \([^)]+\):\s*/, '').slice(0, 200);
					text += `<b>${date}</b> [${r.category}]\n<i>${topic}</i>\n${summary}${summary.length >= 200 ? '...' : ''}\n\n`;
				}

				// Safety: use sendLongMessage for overflow
				await sendLongMessage(chatId, threadId, text, env);
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `Error fetching research history: ${e.message?.slice(0, 100)}`, env);
			}
			return true;
		}
		case "/research": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const topic = (msg.text || '').replace('/research', '').trim();
			if (!topic) {
				await telegram.sendMessage(chatId, threadId, "Usage: <code>/research your topic here</code>\n\nExample: <code>/research latest ADHD coping strategies 2026</code>", env);
				return true;
			}
			if (!env.RESEARCH_WORKFLOW) {
				await telegram.sendMessage(chatId, threadId, "Deep Research Workflow is not available.", env);
				return true;
			}
			const instanceId = `research-${Date.now()}`;
			await env.RESEARCH_WORKFLOW.create({ id: instanceId, params: { chatId, topic, manual: true } });
			await telegram.sendMessage(chatId, threadId, `🔬 <b>Deep Research started</b>\n\nTopic: <i>${topic.slice(0, 200)}</i>\n\nThis will take 2-5 minutes. I will message you when the findings are ready.`, env);
			return true;
		}
		case "/architect": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}

			// Concurrency guard: only one /architect at a time, with kill switch
			const architectLock = await env.CHAT_KV.get(`architect_lock_${chatId}`);
			if (architectLock) {
				const lockAge = Date.now() - parseInt(architectLock);
				const ageSeconds = Math.round(lockAge / 1000);
				await telegram.sendMessage(chatId, threadId,
					`⚙️ <b>Architecture review is already running</b> (${ageSeconds}s ago).\n\nTap below to cancel the stuck run and start fresh.`,
					env, null, {
						inline_keyboard: [[
							{ text: '🔄 Kill & Restart', callback_data: 'architect_kill', style: 'danger' },
							{ text: '⏳ Wait', callback_data: 'noop' }
						]]
					});
				return true;
			}
			await env.CHAT_KV.put(`architect_lock_${chatId}`, String(Date.now()), { expirationTtl: 120 }); // 2 min lock (was 5)

			const statusRes = await telegram.sendMessage(chatId, threadId, "⚙️ <b>Architecture Review</b>\n<i>Starting research...</i>", env);
			const statusMsgId = statusRes?.result?.message_id;

			try {
				const { ARCHITECTURE_SUMMARY } = await import('../config/architecture.js');
				const update = (text) => statusMsgId ? telegram.editMessage(chatId, statusMsgId, `⚙️ <b>Architecture Review</b>\n\n${text}`, env) : null;

				const architectPromise = (async () => {
					// Step 1: Research
					let researchContext = '';
					if (env.TAVILY_API_KEY) {
						await update('<i>Step 1/4: Searching Telegram, Gemini, and AI companion platforms via Tavily...</i>');
						try {
							const { tavilyMultiSearch, formatTavilyForContext } = await import('../services/tavily');
							const tavilyResults = await tavilyMultiSearch([
								'Telegram Bot API latest features 2026',
								'Google Gemini API new agents features 2026',
								'AI chatbot innovations mental health 2026',
							], env, { depth: 'basic', maxResults: 3, timeRange: 'month' });
							researchContext = formatTavilyForContext(tavilyResults, 4000);
							const sourceCount = tavilyResults.results?.length || 0;
							await update(`<i>Step 1/4: ✅ Found ${sourceCount} sources across 3 searches.</i>`);
						} catch (e) {
							console.error('Tavily failed:', e.message);
							await update('<i>Step 1/4: ⚠️ Tavily unavailable, will use Google Search instead.</i>');
						}
					} else {
						await update('<i>Step 1/4: No Tavily key. Will use Gemini Google Search.</i>');
					}

					// Step 2: Generate proposals
					await update(`<i>Step 2/4: Generating innovation proposals with Gemini Pro...\n(This is the longest step, ~15-25 seconds)</i>`);

					const researchSection = researchContext
						? `\n\nRESEARCH FINDINGS (from live web search):\n${researchContext}`
						: '';

					const { text: suggestions } = await generateWithFallback(env,
						[{ role: 'user', parts: [{ text: `You are an AI product strategist reviewing a Telegram AI companion chatbot called Xaridotis. Find 3 unique innovations.

PROJECT REALITY: Pure JavaScript on Cloudflare Workers. No TypeScript/Python.

ARCHITECTURE:
${ARCHITECTURE_SUMMARY}
${researchSection}

RESEARCH ACROSS: Telegram Bot API, Gemini API (Live, Deep Research, ADK), Cloudflare (Workers AI, Workflows, D1, Vectorize), competitors (Pi, Replika, ChatGPT, Claude), therapeutic AI (AEDP, IFS, DBT), and emerging tech (voice AI, wearables, ambient computing).

UNIQUENESS TEST: Would a user switch from ChatGPT for this feature?

For each of 3 proposals: what it is, why it is unique, implementation sketch (files + APIs), and why it matters for mental health.

Be bold. Reference actual file paths.` }] }],
						{ tools: researchContext ? [] : [{ googleSearch: {} }], temperature: 0.7 }
					);

					// Step 3: Validate
					await update('<i>Step 3/4: ✅ Proposals generated. Validating and formatting...</i>');

					if (!suggestions || suggestions.length < 100) {
						await update('<i>❌ Could not generate meaningful suggestions. The model may be overloaded. Try again later.</i>');
						return;
					}

					// Step 4: Save and send
					await update('<i>Step 4/4: Saving to memory and preparing final output...</i>');

					const today = new Date().toISOString().split('T')[0];
					await memoryStore.saveMemory(env, msg.from.id, 'discovery', `Architect review (${today}): ${suggestions.slice(0, 500)}`, 1);

					const finalText = stripLeakedThoughts(suggestions).slice(0, 3900);
					const btns = { inline_keyboard: [[
						{ text: '✅ Approve', callback_data: 'approve_pr', style: 'success' },
						{ text: '❌ Dismiss', callback_data: 'action_dismiss_pr', style: 'danger' }
					]] };

					if (statusMsgId) {
						await telegram.editMessage(chatId, statusMsgId, `<b>Architecture Review</b>\n\n${finalText}`, env, null, btns);
					} else {
						await telegram.sendMessage(chatId, threadId, `<b>Architecture Review</b>\n\n${finalText}`, env, null, btns);
					}
				})(); // end architectPromise

				// Race against 45-second timeout
				const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Architecture review timed out after 45 seconds')), 45000));
				await Promise.race([architectPromise, timeout]);

			} catch (e) {
				console.error('Architect error:', e.message);
				if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, `⚙️ <b>Architecture Review Failed</b>\n<i>${e.message?.slice(0, 100)}</i>`, env);
				else await telegram.sendMessage(chatId, threadId, `Architecture review failed: ${e.message?.slice(0, 100)}`, env);
			} finally {
				await env.CHAT_KV.delete(`architect_lock_${chatId}`);
			}
			return true;
		}
		case "/schedule": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			const schedules = await getAllSchedules(env);
			let text = '⏰ <b>Current Schedules</b>\n\n';
			for (const [key, s] of Object.entries(schedules)) {
				const time = s.hour !== undefined ? `${String(s.hour).padStart(2, '0')}:${String(s.minute || 0).padStart(2, '0')}` : 'every hour';
				const day = s.day !== undefined ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day] : '';
				const date = s.date !== undefined ? `${s.date}th` : '';
				text += `• <b>${s.label || key}</b>: ${day}${date} ${time}\n`;
			}
			text += '\n<i>To change a schedule, say something like "Move my morning check-in to 10:00" and I will update it.</i>';
			await telegram.sendMessage(chatId, threadId, text, env);
			return true;
		}
		default: return false;
	}
}

export async function handleMessage(msg, env) {
	const chatId = msg.chat.id, messageId = msg.message_id, threadId = msg.message_thread_id || "default";
	const userId = msg.from?.id;
	const replyToMessageId = msg.reply_to_message?.message_id || null;
	const bizConnId = msg.business_connection_id || null;

	// Skip messages from bots (including our own)
	if (msg.from?.is_bot) return;

	// DIAGNOSTICS: track total elapsed time and last checkpoint.
	// Helps distinguish waitUntil timeout from generation timeout from setup bottleneck.
	const _t0 = Date.now();
	const _elapsed = () => Date.now() - _t0;

	try {
		const firstName = msg.from.first_name || "User";
		// userText is mutable: Phase C may append a voice transcript before routing.
		let userText = msg.text || msg.caption || "";
		log.info('message_received', { chatId, from: firstName, len: userText.length, hasMedia: !!getMediaFromMessage(msg) });

		// Track last seen for contextual outreach timing
		await env.CHAT_KV.put(`last_seen_${chatId}`, String(Date.now()), { expirationTtl: 86400 * 7 });
		const userIdentity = buildUserIdentity(msg);
		upsertUser(env, msg); // fire-and-forget — keeps users table fresh
		const cmdMatch = userText.match(/^\/(\w+)(@\w+)?/);
		if (cmdMatch) {
			log.info('command', { chatId, cmd: cmdMatch[1] });
			if (await handleCommand(`/${cmdMatch[1]}`, msg, env)) return;
		}

		// Deep Listening Mode: buffer messages silently, react with contextual emoji
		const isListening = await env.CHAT_KV.get(`listening_mode_${chatId}`);
		if (isListening) {
			const bufferStr = await env.CHAT_KV.get(`listen_buffer_${chatId}`) || '[]';
			const buffer = JSON.parse(bufferStr);
			const listenTz = await getTimezone(chatId, env);
			const timestamp = new Date().toLocaleTimeString('en-GB', { timeZone: listenTz });
			buffer.push(`[${timestamp}] ${userText || '(Media uploaded)'}`);
			await env.CHAT_KV.put(`listen_buffer_${chatId}`, JSON.stringify(buffer), { expirationTtl: 86400 });

			// Let Gemini pick a contextual reaction emoji
			try {
				const emojiResponse = await generateShortResponse(
					`Read this message and react with the ONE emoji that best captures its emotional tone. Choose freely from this supported set: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ⛄ 💅 🤪 🗿 🆒 💘 🙉 🦄 😽 💊 🙊 🕶 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡\n\nOutput ONLY the emoji. Nothing else.\n\nMessage: "${(userText || 'media').slice(0, 200)}"`,
					'You select emojis based on emotional context. Output ONLY a single emoji, no text.',
					env
				);
				const emoji = emojiResponse?.match(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/u)?.[0] || '👀';
				await telegram.sendReaction(chatId, messageId, emoji, env);
			} catch {
				await telegram.sendReaction(chatId, messageId, '👀', env).catch(() => {});
			}
			return;
		}

		await telegram.sendChatAction(chatId, threadId, "typing", env, bizConnId);

		// Dynamic context throttling: skip heavy D1/Vectorize queries for short, low-value replies
		const hasMedia = !!getMediaFromMessage(msg);

		// =========================================================
		// Phase C: Pre-flight transcription for voice / audio media.
		// =========================================================
		// Voice notes arrive with empty userText — routing and memory filters
		// see only the audio bytes. We transcribe via Flash-Lite up-front so
		// every downstream signal (tagger, regex, complexity heuristics, route
		// selector) has actual content to work with.
		//
		// The audio is still passed to the main response model in userParts.
		// Transcript is for routing / context, not a replacement for audio.
		//
		// We download the audio HERE and cache the bytes so the later media
		// block doesn't re-download. cachedMedia survives in scope for the
		// entire handler.
		let cachedMedia = null; // { base64, buffer, filePath, fileSize, mime, fileId } when pre-downloaded
		if (hasMedia) {
			const _media = getMediaFromMessage(msg);
			const isAudio = (_media.mimeHint || '').startsWith('audio/');
			if (isAudio) {
				const _t = Date.now();
				try {
					const download = await telegram.downloadFile(_media.fileId, env);
					cachedMedia = { ...download, mime: _media.mimeHint, fileId: _media.fileId };

					const { transcribeAudio } = await import('../services/transcription');
					const result = await transcribeAudio(env, download.base64, _media.mimeHint);

					if (result.success && result.text) {
						// Append transcript to userText so all downstream signals see it.
						userText = userText
							? `${userText}\n\n[Voice transcript]: ${result.text}`
							: `[Voice transcript]: ${result.text}`;
						log.info('transcription_complete', {
							chatId,
							chars: result.text.length,
							latency_ms: result.latency_ms,
							total_elapsed_ms: _elapsed(),
						});
					} else {
						log.warn('transcription_skipped', {
							chatId,
							error: result.error,
							latency_ms: result.latency_ms,
						});
					}
				} catch (e) {
					log.warn('transcription_failed', {
						chatId,
						msg: (e.message || '').slice(0, 200),
						elapsed_ms: Date.now() - _t,
					});
					// Fall through — audio still routes to Pro via hasMedia rule,
					// just without a transcript to inform memory filtering etc.
				}
			}
		}

		const isSubstantive = userText.length > 15 || userText.includes('?') || hasMedia;

		// Pre-compute register signals so memCtx can be filtered by mode.
		// Three modes:
		//   warm     — emotional language, mental-health keywords, active health check-in
		//   technical — code/arch/research keywords (subset of detectComplexTask)
		//   default  — everything else (casual chat, data points, small talk)
		// Casual messages no longer drag in 15KB of clinical history.
		const earlyEmotional = /\b(anxious|depressed|panic|overwhelm|scared|lonely|empty|hopeless|angry|frustrated|sad|grief|trigger|manic|racing|numb|crying|breakdown|struggling|worried|stressed|spiralling)\b/i.test(userText);
		const earlyTechnical = /\b(code|function|bug|error|deploy|refactor|implement|architecture|PR|pull request|commit|git|webpack|npm|wrangler|api|endpoint|database|query|sql|schema|migration|docker|kubernetes|aws|cloudflare|workers)\b/i.test(userText) || /\.(js|ts|py|json|css|html|jsx|mjs)\b/.test(userText) || /```/.test(userText);
		const earlyHealthCheckin = await env.CHAT_KV.get(`health_checkin_active_${chatId}`);
		const ctxMode = (earlyEmotional || earlyHealthCheckin) ? 'warm' : earlyTechnical ? 'technical' : 'default';

		const [memCtxResult, semanticCtx, personaKey, rawHistory] = await Promise.all([
			isSubstantive ? memoryStore.getFormattedContext(env, userId, ctxMode, userText) : Promise.resolve({ ctx: '', memories: [], debug: { mode: ctxMode, total: 0, skipped: 'not_substantive' } }),
			isSubstantive ? vectorStore.getSemanticContext(env, userId, userText) : Promise.resolve(''),
			env.CHAT_KV.get(`persona_${chatId}_${threadId}`),
			env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: "json" })
		]);

		const memCtx = memCtxResult?.ctx || '';
		const memCtxDebug = memCtxResult?.debug || { mode: ctxMode, total: 0 };
		const memCtxRows = memCtxResult?.memories || [];

		const activePersona = getPersona(personaKey);
		const hist = sanitizeHistory(rawHistory || []);

		// Pre-response curator (Phase 4). For substantive turns, kick off a
		// Flash-Lite analysis pass that returns:
		//   - register override (in case our regex was wrong)
		//   - structured flags (crisis, med_question, project_continuity, etc)
		//   - relevant_memory_ids (which memories actually matter for this turn)
		//   - reasoning summary the main model can read
		// Result is prepended to the dynamic context block so the main model gets
		// a curated handoff. Skipped for short messages, active health check-ins
		// (register already locked), and when there's nothing to curate.
		//
		// Latency budget: ~200-400ms via Flash-Lite. We don't await before doing
		// other prep, but we DO await before prompt assembly — the prepend has to
		// be in place when the prompt is built.
		let curatorPromise = Promise.resolve(null);
		const shouldCurate = isSubstantive && userText.length >= 30 && !earlyHealthCheckin && (memCtxRows.length > 0 || semanticCtx.length > 0);
		if (shouldCurate) {
			const { curateContext } = await import('../services/responseCurator');
			curatorPromise = curateContext(env, {
				userText,
				memories: memCtxRows,
				recentHistory: hist,
				semanticCtxPreview: semanticCtx,
			}).catch(e => {
				log.warn('curator_promise_rejected', { msg: e.message });
				return null;
			});
		}


		// Model routing happens AFTER currentCheckin is determined (post-clear logic).
		// We need currentCheckin (not healthCheckin) so the router sees the correct
		// state when the user has just dropped out of a check-in flow.
		//
		// modelOverride is read here so we can both delete the one-shot key and
		// pass the resolved model string to routeMessage. The resolution from
		// 'pro'/'flash'/'lite' to actual model strings happens at the call site
		// because router.js uses raw model strings.
		const isOwner = env.OWNER_ID && String(userId) === String(env.OWNER_ID);

		// Check health check-in state early (used for clear-flag logic and as input
		// to the route call below).
		const healthCheckin = isOwner ? await env.CHAT_KV.get(`health_checkin_active_${chatId}`) : null;

		const modelOverride = await env.CHAT_KV.get(`model_override_${chatId}_${threadId}`);
		if (modelOverride) await env.CHAT_KV.delete(`model_override_${chatId}_${threadId}`);

		const resolvedOverride = modelOverride === 'pro' ? PRIMARY_TEXT_MODEL
			: modelOverride === 'flash' ? FALLBACK_TEXT_MODEL
			: modelOverride === 'lite' ? FLASH_LITE_TEXT_MODEL
			: modelOverride || null; // pass through raw model string if it's already one

		const effectivePersona = activePersona;

		// Fetch per-user persona config from D1 (voice, tone, evolved traits)
		const personaConfig = await personaStore.getPersona(env, userId, effectivePersona).catch(() => null);

		// If the user is clearly NOT engaging with a health check-in, clear the flag.
		const isHealthRelated = /sleep|mood|medication|medic|anxious|anxiety|depressed|how.*feel|emotion|check.?in/i.test(userText);
		if (healthCheckin && !isHealthRelated && userText.length > 10) {
			await env.CHAT_KV.delete(`health_checkin_active_${chatId}`);
			log.info('checkin_cleared', { chatId, reason: 'non_health_message', was: healthCheckin });
		}

		// Only inject check-in context if the flag survived.
		const currentCheckin = await env.CHAT_KV.get(`health_checkin_active_${chatId}`);

		// textModel will be derived from the route once we have all signals
		// (mode from tagger, currentCheckin post-clear). Declared here so it's
		// in scope for cache setup and the generation loop.
		let textModel;

		// =========================================================
		// Phase B: Unified routing.
		// =========================================================
		// Run the conversation-mode tagger in parallel-safe fashion (~500ms
		// typical via Llama 8B; full chain has 8s budget with heuristic floor).
		// The tagger output feeds the router as one of several signals — it is
		// NOT a hard switch. The router still applies regex, complexity, and
		// override rules in priority order.
		const _tTagger = Date.now();
		const { tagConversationMode } = await import('../services/cfAi');
		const tagResult = await tagConversationMode(env, userText, hist.slice(-4)).catch((e) => {
			log.warn('tagger_failed_in_hot_path', { msg: e.message });
			return { mode: null };
		});
		log.info('tagger_resolved', {
			chatId,
			mode: tagResult?.mode,
			source: tagResult?.source,
			latency_ms: Date.now() - _tTagger,
		});

		// Single source of truth: every signal flows into routeMessage.
		// router.js owns the priority order — handlers.js no longer duplicates
		// the tier-selection logic.
		const route = routeMessage({
			userText,
			healthCheckinActive: !!currentCheckin,
			hasMedia,
			mode: tagResult?.mode,
			modelOverride: resolvedOverride,
		});

		// Derive the Gemini fallback model. For the CF path, route.model is the
		// CF model id (handled by createProvider); textModel is what we'd fall
		// BACK to if the CF path errors out, hence FALLBACK_TEXT_MODEL (Flash).
		// For the Gemini path, textModel = route.model directly.
		if (route.provider === 'gemini') {
			textModel = route.model;
		} else {
			textModel = FALLBACK_TEXT_MODEL;
		}
		log.info('model_route_resolved', {
			chatId,
			provider: route.provider,
			model: route.model,
			textModel,
			reason: route.reason,
			override: !!resolvedOverride,
		});

		// Build dynamic journal roadmap for evening check-ins
		let checkinProgress = '';
		if (currentCheckin === 'evening') {
			const roadmap = await getCheckinRoadmap(env, userId);
			if (roadmap.includes('All data collected')) {
				checkinProgress = ` | ${roadmap}`;
				env.CHAT_KV.delete(`health_checkin_active_${chatId}`);
			} else {
				checkinProgress = ` | ${roadmap}`;
			}
		} else if (currentCheckin) {
			checkinProgress = ` | HEALTH CHECK-IN MODE (${currentCheckin}): Conduct the ${currentCheckin} check-in naturally. Use log_mood_entry to record data. If the user changes topic, drop the check-in and help with their request instead.`;
		}

		let replyContext = "";
		if (msg.reply_to_message) replyContext = `\n[User is replying to ${msg.reply_to_message.from?.first_name || "Someone"}: "${(msg.reply_to_message.text || msg.reply_to_message.caption || "").slice(0, 500)}"]\n`;

		// Resolve the base persona instruction (built-in definition)
		const basePersonaKey = personaConfig?.base_persona || effectivePersona;
		const personaInstruction = personas[basePersonaKey]?.instruction || personas.xaridotis.instruction;

		// Build per-user persona traits overlay
		const personaTraits = personaStore.buildPersonaTraits(personaConfig);
		const customInstruction = personaConfig?.custom_instruction || '';

		const weatherCtx = await getWeatherContext(env);

		// Familiarity Index: track relationship length
		let firstSeen = await env.CHAT_KV.get(`first_seen_${chatId}`);
		if (!firstSeen) {
			firstSeen = String(Date.now());
			await env.CHAT_KV.put(`first_seen_${chatId}`, firstSeen);
		}
		const daysKnown = Math.floor((Date.now() - parseInt(firstSeen)) / 86400000);

		// CoALA: batch all episode/procedural queries in parallel to reduce D1 load
		let episodeCtx = '';
		let planCtx = '';
		let proceduralCtx = '';
		const isEmotionalMsg = /\b(anxious|depressed|panic|overwhelm|scared|lonely|empty|hopeless|angry|frustrated|sad|grief|trigger|manic|racing|numb|crying|breakdown|struggling|worried|stressed)\b/i.test(userText);

		if (isEmotionalMsg) {
			// Run all CoALA D1 queries in parallel (single round-trip instead of 5 sequential)
			const [episodes, insights] = await Promise.all([
				episodeStore.getRecentEpisodes(env, userId, 5).catch(() => []),
				episodeStore.getProceduralInsights(env, userId).catch(() => ({ worked: [], didntWork: [] })),
			]);

			episodeCtx = episodeStore.formatEpisodesForContext(episodes);
			proceduralCtx = episodeStore.formatProceduralContext(insights);

			// Planning step uses the already-fetched data (no extra D1 calls)
			if (isOwner && (episodes.length || insights.worked.length || insights.didntWork.length)) {
				const { generatePlan } = await import('../services/planner');
				const plan = await generatePlan(env, userId, userText, null).catch(() => null);
				if (plan) planCtx = `\nACTION PLAN (your internal reasoning, do NOT share this with the user):\n${plan}`;
			}
		}

		// GraphRAG: query knowledge graph for relational context
		let graphCtx = '';
		if (isEmotionalMsg && userText.length > 10) {
			const { queryRelated, formatGraphContext } = await import('../services/knowledgeGraph');
			// Extract key concepts from the message to query the graph
			const keywords = userText.match(/\b[A-Za-z]{4,}\b/g)?.slice(0, 3) || [];
			const graphResults = [];
			for (const kw of keywords) {
				const triples = await queryRelated(env, userId, kw, 5).catch(() => []);
				graphResults.push(...triples);
			}
			// Deduplicate by ID
			const seen = new Set();
			const unique = graphResults.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
			graphCtx = formatGraphContext(unique);
		}

		// Load the user's style card (communication preferences, interests, subjective opinions).
		// Loaded here so Xaridotis does not have to infer these from scattered memories every turn.
		const styleCard = await getStyleCard(env, userId);
		const styleCardSection = styleCard ? `\n\n=== USER STYLE CARD ===\n${styleCard}\n=== END STYLE CARD ===` : '';

		// Use the user's stored timezone (from location pin or /timezone) for the
		// "Local Time" context line passed to Gemini. Falls back to UTC when nothing
		// stored, matching the policy in src/lib/timezone.js.
		const promptTz = await getTimezone(chatId, env);
		const localTimeLabel = new Date().toLocaleString("en-GB", { timeZone: promptTz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

		// Phase 4 finalisation: await the curator and build the prepend block.
		// Curator output goes BEFORE the MEMORY section so the main model reads:
		//   1. Persona traits / custom instruction
		//   2. Curator analysis (register, flags, reasoning, selected memory IDs)
		//   3. Raw MEMORY block (still included — curator may have missed something)
		//   4. Semantic / episode / procedural / graph / plan context
		// The dual presence of curator-selected memories + raw MEMORY is intentional.
		// The curator's selection acts as a SPOTLIGHT, not a filter; the main model
		// still sees the full retrieved context but knows which items the curator
		// flagged as load-bearing for THIS turn.
		let curatedPrepend = '';
		let curatorRegister = null;
		try {
			const curatorResult = await curatorPromise;
			if (curatorResult) {
				const { buildCuratedPrepend } = await import('../services/responseCurator');
				curatedPrepend = buildCuratedPrepend(curatorResult, memCtxRows);
				curatorRegister = curatorResult.register;
				log.info('curator_applied', {
					chatId,
					register: curatorResult.register,
					flagCount: curatorResult.flags.length,
					relevantIds: curatorResult.relevant_memory_ids.length,
					prependChars: curatedPrepend.length,
				});
			}
		} catch (curErr) {
			log.warn('curator_await_failed', { msg: curErr.message });
		}

		const dynamicContext = `[Context] Current speaker: ${userIdentity} | Local Time (${promptTz}): ${localTimeLabel} | Unix: ${Math.floor(Date.now() / 1000)}${weatherCtx ? ` | ${weatherCtx}` : ''} | Relationship: ${daysKnown} days | Persona: ${personaConfig?.display_name || effectivePersona}${checkinProgress}${personaTraits ? `\n\nPERSONA TRAITS FOR THIS USER:\n${personaTraits}` : ''}${customInstruction ? `\n\nCUSTOM INSTRUCTION:\n${customInstruction}` : ''}${curatedPrepend ? `\n\n${curatedPrepend}` : ''}\n\nMEMORY:\n${memCtx}${semanticCtx}${episodeCtx ? `\n\n${episodeCtx}` : ''}${proceduralCtx ? `\n\n${proceduralCtx}` : ''}${graphCtx ? `\n\n${graphCtx}` : ''}${planCtx}`;

		// DIAGNOSTICS: size breakdown — tells us which dynamic section is bloating the prompt
		log.info('prompt_sizes', {
			chatId,
			model: textModel,
			ctxMode,
			curatorRegister,
			memCtx_total: memCtxDebug.total || 0,
			memCtx_kept: (memCtxDebug.factual_kept || 0) + (memCtxDebug.therapeutic_kept || 0) + (memCtxDebug.feedback_kept || 0) + (memCtxDebug.triples_kept || 0),
			memCtx_factual: memCtxDebug.factual_kept || 0,
			memCtx_therapeutic: memCtxDebug.therapeutic_kept || 0,
			memCtx_feedback: memCtxDebug.feedback_kept || 0,
			memCtx_triples: memCtxDebug.triples_kept || 0,
			persona_chars: personaInstruction.length,
			styleCard_chars: styleCardSection.length,
			memCtx_chars: memCtx.length,
			curated_chars: curatedPrepend.length,
			semanticCtx_chars: semanticCtx.length,
			episodeCtx_chars: episodeCtx.length,
			proceduralCtx_chars: proceduralCtx.length,
			graphCtx_chars: graphCtx.length,
			planCtx_chars: planCtx.length,
			dynamic_total_chars: dynamicContext.length,
			hasMedia,
			isEmotionalMsg,
			elapsed_ms: _elapsed(),
		});

		// (dynamic_context_dump removed — was a 15KB-per-message debug that's no
		// longer needed now that prompt_sizes captures memCtx structure via memCtxDebug.)

		// Skip code execution when media is present (incompatible with audio/video inline data)
		// Also skip cache when media is present, because the cache has codeExecution baked in
		// MENTAL_HEALTH_DIRECTIVE is now baked into the cache alongside persona + formatting
		// rules, so the clinical protocol reaches the model on cache-hit calls too (register
		// override inside the directive keeps it inert during casual chat).
		const _tCacheStart = Date.now();
		let cacheContext = hasMedia ? null : await setupCache(personaInstruction, FORMATTING_RULES, dynamicContext, env, textModel, MENTAL_HEALTH_DIRECTIVE);
		log.info('cache_setup_done', { elapsed_ms: Date.now() - _tCacheStart, hadCache: !!cacheContext, total_elapsed_ms: _elapsed() });

		// Context budgeting for the NON-CACHED path only (first message, media, cache expired).
		// When cache is active, MENTAL_HEALTH_DIRECTIVE is already inside the cache and
		// fullSysPrompt is dropped by buildCachedConfig anyway.
		// SECOND_BRAIN_DIRECTIVE stays out of the cache because it's only relevant for
		// complex technical tasks — gating it saves tokens on the non-cached path.
		const clinicalDirective = (isEmotionalMsg || healthCheckin) ? `\n\n${MENTAL_HEALTH_DIRECTIVE}` : '';
		const techDirective = detectComplexTask(userText) ? `\n\n${SECOND_BRAIN_DIRECTIVE}` : '';
		const fullSysPrompt = `${personaInstruction}${styleCardSection}${clinicalDirective}${techDirective}\n\n${FORMATTING_RULES}\n${dynamicContext}`;

		// =========================================================
		// Path B fast-path — Cloudflare provider for casual chat
		// =========================================================
		// `route` was resolved earlier (see Phase B block above) — handlers.js
		// no longer recomputes routing here. We just consult the resolved route
		// and dispatch to the CF provider when it picked one.
		//
		// Bypasses Gemini cache + tool loop because:
		//   - Gemma/Qwen handle tool calls via OpenAI-compat (different shape)
		//   - Cache is Gemini-specific (cachedContent on Google's models)
		//   - For casual chat we don't need the heavyweight Gemini setup
		// Multimodal, emotional, override, and active-checkin messages went to
		// Gemini in the router, so they never reach this branch.

		if (route.provider === 'cloudflare' && !resolvedOverride && env.AI) {
			try {
				const provider = createProvider(route, env);
				const cfMessages = [];
				for (const turn of hist) {
					const role = turn.role === 'model' ? 'model' : 'user';
					const text = (turn.parts || []).map(p => p.text).filter(Boolean).join('');
					if (text) cfMessages.push({ role, content: text });
				}
				cfMessages.push({ role: 'user', content: userText });

				// Animated streaming via Telegram draft bubble.
				// Pattern mirrors the existing Gemini path: random non-zero
				// draft_id, throttled at DRAFT_THROTTLE_MS, finalised with
				// sendMessage which replaces the draft. On error we clear
				// the draft so the user doesn't see a ghost "..." bubble.
				const tStream = Date.now();
				const cfDraftId = Math.floor(Math.random() * 2147483646) + 1;
				let cfDraftActive = false;
				let cfLastDraft = 0;
				let finalText = '';

				try {
					for await (const chunk of provider.chatStream(cfMessages, [], {
						systemInstruction: fullSysPrompt,
						temperature: 1.0,
						maxTokens: 1200,
					})) {
						if (chunk.type === 'text' && chunk.text) {
							finalText += chunk.text;
							const now = Date.now();
							if (now - cfLastDraft >= DRAFT_THROTTLE_MS && finalText.trim()) {
								// Strip incomplete HTML at the tail to avoid mid-stream parse errors
								const safeDraft = finalText.replace(/<[^>]*$/, '');
								if (safeDraft.trim()) {
									// Fire-and-forget so the next chunk doesn't wait on the network
									telegram.sendMessageDraft(chatId, threadId, cfDraftId, safeDraft, env, msg.message_id);
									cfDraftActive = true;
									cfLastDraft = now;
								}
							}
						}
					}
				} catch (streamErr) {
					// Streaming failed mid-flight. Clear the draft and try
					// non-streaming chat() for a clean retry on the same provider.
					if (cfDraftActive) {
						await telegram.clearMessageDraft(chatId, threadId, cfDraftId, env).catch(() => {});
						cfDraftActive = false;
					}
					log.warn('cf_stream_failed_retry_chat', { msg: streamErr.message });
					const r = await provider.chat(cfMessages, [], {
						systemInstruction: fullSysPrompt,
						temperature: 1.0,
						maxTokens: 1200,
					});
					finalText = r.text || '';
				}
				finalText = (finalText || '').trim();
				if (!finalText) throw new Error('cf_empty_response');

				// Finalise: send the complete reply. This implicitly replaces
				// the draft bubble (Telegram pairs the draft_id with the next
				// real send to the same chat). If draft was never started
				// (very fast response under throttle), this is the only send.
				await telegram.sendMessage(chatId, threadId, finalText, env, msg.message_id);

				// Defensive: if for any reason the draft bubble didn't auto-clear,
				// explicitly discard it so the user doesn't see a stale "..." 
				if (cfDraftActive) {
					await telegram.clearMessageDraft(chatId, threadId, cfDraftId, env).catch(() => {});
				}

				try {
					const newHist = [...hist,
						{ role: 'user', parts: [{ text: userText }] },
						{ role: 'model', parts: [{ text: finalText }] },
					];
					await env.CHAT_KV.put(`history_${chatId}_${threadId}`, JSON.stringify(newHist), { expirationTtl: 86400 * 7 });
				} catch (histErr) {
					log.warn('cf_history_save_failed', { msg: histErr.message });
				}

				log.info('cf_path_complete', {
					model: route.model,
					reason: route.reason,
					chars: finalText.length,
					elapsed_ms: Date.now() - tStream,
					animated: cfDraftActive,
				});
				log.info('message_handled', {
					chatId,
					userId,
					provider: 'cloudflare',
					model: route.model,
					route_reason: route.reason,
					ctxMode,
					inputLen: userText.length,
					outputLen: finalText.length,
					memCtx_chars: memCtx.length,
					memCtx_kept: (memCtxDebug.factual_kept || 0) + (memCtxDebug.therapeutic_kept || 0) + (memCtxDebug.feedback_kept || 0) + (memCtxDebug.triples_kept || 0),
					hasMedia,
					isEmotionalMsg: earlyEmotional || !!earlyHealthCheckin,
					outcome: 'success_cf',
					total_elapsed_ms: _elapsed(),
				});
				log.info('handler_end', { chatId, total_elapsed_ms: _elapsed(), outcome: 'success_cf' });
				return;
			} catch (cfErr) {
				log.warn('cf_path_failed_falling_through', { msg: cfErr.message, model: route.model });
				// CRITICAL: when we fall through from the CF path to Gemini, we
				// must invalidate the cache that was built for the original
				// (pre-fallthrough) Gemini tier. The cache was created earlier
				// for whatever textModel was selected before the router decision;
				// reusing it with a different model causes a 400 from Gemini:
				//   "Model used by GenerateContent and CachedContent has to be the same."
				// Set cacheContext to null so createChat rebuilds without it.
				textModel = FALLBACK_TEXT_MODEL;
				cacheContext = null;
			}
		}
		// =========================================================
		// End Path B fast-path
		// =========================================================

		let chat;

		const chatOpts = { skipCodeExecution: hasMedia };

		const _tChatStart = Date.now();
		try {
			chat = await createChat(hist, fullSysPrompt, env, cacheContext, textModel, chatOpts);
		} catch (cacheErr) {
			// If cache is stale (403), retry without cache
			if (cacheErr.message?.includes('403') || cacheErr.message?.includes('CachedContent')) {
				log.warn('cache_stale_retry', { msg: cacheErr.message });
				chat = await createChat(hist, fullSysPrompt, env, null, textModel, chatOpts);
			} else {
				throw cacheErr;
			}
		}
		log.info('chat_ready', { elapsed_ms: Date.now() - _tChatStart, total_elapsed_ms: _elapsed(), model: textModel });

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
				if (userParts.length === 0 || (!userText && !replyContext && !cacheContext)) {
					if (media.mimeHint.startsWith("video/")) {
						userParts.unshift({ text: "Analyse this video. Comment on composition, lighting, pacing, and any specific content. If it looks like a drone or creative project, suggest editing techniques to improve it." });
					} else if (media.mimeHint.startsWith("audio/")) {
						userParts.unshift({ text: "Transcribe and respond to this audio message." });
					} else {
						userParts.unshift({ text: "Describe or respond to this media." });
					}
				}
				// Store media in R2 (fire-and-forget) — pass raw buffer, no decoding
				if (env.MEDIA_BUCKET) {
					const mediaType = media.mimeHint.split('/')[0];
					mediaStore.storeMedia(env, userId, mediaType, buffer, media.mimeHint, {
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
		// Mutable so the Pro→Flash fallback path can issue a fresh draftId
		// to cleanly discard any orphaned Pro draft bubble.
		let draftId = Math.floor(Math.random() * 2147483646) + 1;
		let draftActive = false; // tracks if we've sent at least one draft update
		let lastDraftTime = 0;

		let isComplete = false, fullText = "", lastSentMsgId = null;
		let nextMessage = userParts;
		let isFirstPass = true;

		// Pro→Flash fallback: if Pro fails with overload/rate-limit, retry with Flash
		let _passIndex = 0;

		// Cap total generation passes to prevent infinite tool-call loops that blow
		// through the 30s waitUntil ceiling. 4 passes = up to 4 tool-call round-trips,
		// which is plenty for any legitimate use case. If we hit the cap, we force
		// Gemini to emit a final text response using existing tool results.
		const MAX_PASSES = 4;

		const runGenerateLoop = async () => {
		while (!isComplete) {
			// Hard cap on passes: after MAX_PASSES, force a final text pass by
			// injecting a system-level nudge telling the model to respond to the user
			// without calling any more tools. This prevents infinite tool loops.
			if (_passIndex >= MAX_PASSES) {
				log.warn('max_passes_hit', {
					chatId,
					pass: _passIndex,
					response_chars: fullText.length,
					total_elapsed_ms: _elapsed(),
				});
				// Append a forcing instruction to the next message. The next iteration
				// will be a plain text request — Gemini should produce a final reply.
				nextMessage = [{
					text: 'SYSTEM: You have already gathered sufficient context via tool calls. Respond to the user now with a natural language message. Do not call any more tools.'
				}];
				// Temporarily hide tools on the next call by using the non-streaming path.
				// Note: we can't remove tools mid-session, but we can tell the model not
				// to use them. If it still calls a tool, we break out anyway.
			}
			// Safety valve: absolute ceiling at MAX_PASSES + 1 to avoid any possibility
			// of an infinite loop if the forcing instruction is ignored.
			if (_passIndex >= MAX_PASSES + 1) {
				log.error('runaway_loop_break', {
					chatId,
					pass: _passIndex,
					total_elapsed_ms: _elapsed(),
				});
				if (!fullText.trim()) {
					fullText = 'I gathered some information but ran out of time composing a reply. Could you rephrase what you were asking?';
				}
				isComplete = true;
				break;
			}
			// Streaming vs non-streaming decision:
			// - First pass with no tool calls: streaming (animated text) UNLESS media
			//   is present. Voice/audio/video/image uploads increase Gemini's time-to-
			//   first-chunk significantly (observed 20s+); streaming through the draft
			//   bubble adds complexity with no UX gain on media replies (user is not
			//   watching for typing animation after uploading a voice note).
			// - Tool-calling passes: non-streaming (need complete response for
			//   function call/response pairs).
			const useStreaming = isFirstPass && !hasMedia;

			// DIAGNOSTICS: mark start of generation call — if we never see generation_complete
			// for this pass, it means the model call itself hung or was cancelled mid-stream.
			const _tGenStart = Date.now();
			_passIndex++;
			log.info('generation_start', {
				chatId,
				pass: _passIndex,
				streaming: useStreaming,
				model: textModel,
				total_elapsed_ms: _elapsed(),
			});

			const stream = useStreaming
				? sendChatMessageStream(chat, nextMessage)
				: sendChatMessage(chat, nextMessage);

			let passText = "", toolCalls = [];
			let _firstChunkTime = null;
			let _finishReason = null;
			let _blockReason = null;

			for await (const chunk of stream) {
				if (_firstChunkTime === null) _firstChunkTime = Date.now();
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
				} else if (chunk.type === 'finishReason') {
					_finishReason = chunk.reason;
				} else if (chunk.type === 'blockReason') {
					_blockReason = chunk.reason;
				}
			}

			// DIAGNOSTICS: generation pass finished (may loop again if tool calls present)
			log.info('generation_complete', {
				chatId,
				pass: _passIndex,
				elapsed_ms: Date.now() - _tGenStart,
				ttfb_ms: _firstChunkTime ? _firstChunkTime - _tGenStart : null,
				response_chars: passText.length,
				tool_calls: toolCalls.length,
				tool_names: toolCalls.map(c => c.functionCall?.name).filter(Boolean),
				finish_reason: _finishReason,
				block_reason: _blockReason,
				total_elapsed_ms: _elapsed(),
			});

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
							const voiceOverride = personaConfig?.voice_name ? { voice: personaConfig.voice_name, locale: personaConfig.voice_locale || 'en-US' } : null;
							const buf = await generateSpeech(args.text_to_speak, effectivePersona, env, voiceOverride);
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
								mediaStore.storeMedia(env, userId, 'generated', imageBase64, mimeType, {
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
					// Strip any leaked internal reasoning before sending to user
					fullText = stripLeakedThoughts(fullText);

					const btns = { inline_keyboard: [[{ text: "🔊 Voice", callback_data: "action_voice" }, { text: "🗑️ Delete", callback_data: "action_delete_msg" }]] };

					lastSentMsgId = await sendLongMessage(chatId, threadId, fullText, env, messageId, btns, bizConnId);
				}
			}
		}
		}; // end runGenerateLoop

		try {
			await runGenerateLoop();
		} catch (proErr) {
			const errMsg = proErr?.message || '';
			const errCode = proErr?.code || proErr?.status || null;
			const isIdle = proErr instanceof StreamIdleError || proErr?.code === 'STREAM_IDLE';
			const isOverload = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')
				|| errMsg.includes('overloaded') || errMsg.includes('unavailable') || errMsg.includes('UNAVAILABLE')
				|| errMsg.includes('DEADLINE_EXCEEDED') || errMsg.includes('INTERNAL')
				|| proErr?.status === 503 || proErr?.status === 429 || proErr?.status === 500 || proErr?.status === 504;
			const isRetryable = isIdle || isOverload;

			// Full error signal capture for observability — so we can see in logs
			// exactly what Gemini returned (or failed to return).
			log.warn('generation_failed', {
				chatId,
				model: textModel,
				retryable: isRetryable,
				is_idle_stall: isIdle,
				err_code: errCode,
				err_name: proErr?.name,
				err_status: proErr?.status,
				retry_after: proErr?.headers?.['retry-after'] || proErr?.retryAfter || null,
				err_msg: errMsg.slice(0, 200),
			});

			if (isRetryable && textModel === PRIMARY_TEXT_MODEL) {
				log.warn('pro_fallback_to_flash', { error: errMsg.slice(0, 100), model: textModel, reason: isIdle ? 'stream_idle' : 'overload' });

				// Delete the orphaned draft bubble from the failed attempt so Telegram
				// doesn't show a ghost "..." message alongside the Flash reply.
				if (draftActive) {
					try {
						await telegram.clearMessageDraft(chatId, threadId, draftId, env);
					} catch { /* best-effort cleanup */ }
				}

				// Reset state for retry — nextMessage keeps the ORIGINAL userParts
				// so the user never has to resend.
				textModel = FALLBACK_TEXT_MODEL;
				isComplete = false;
				fullText = "";
				lastSentMsgId = null;
				nextMessage = userParts;
				isFirstPass = true;
				draftId = Math.floor(Math.random() * 2147483646) + 1;
				draftActive = false;
				lastDraftTime = 0;

				const flashCache = hasMedia ? null : await setupCache(personaInstruction, FORMATTING_RULES, dynamicContext, env, FALLBACK_TEXT_MODEL, MENTAL_HEALTH_DIRECTIVE);
				chat = await createChat(hist, fullSysPrompt, env, flashCache, FALLBACK_TEXT_MODEL, { skipCodeExecution: hasMedia });
				await runGenerateLoop();
			} else if (isIdle && textModel === FALLBACK_TEXT_MODEL) {
				// Flash streamed-and-stalled. Last-resort safety net: retry same model
				// but force non-streaming. This catches the "stream never emits first chunk"
				// case without changing models. User message is preserved.
				log.warn('flash_stall_nonstream_retry', { error: errMsg.slice(0, 100) });

				if (draftActive) {
					try {
						await telegram.clearMessageDraft(chatId, threadId, draftId, env);
					} catch { /* best-effort cleanup */ }
				}

				isComplete = false;
				fullText = "";
				lastSentMsgId = null;
				nextMessage = userParts;
				isFirstPass = false; // force non-streaming path inside runGenerateLoop
				draftActive = false;

				await runGenerateLoop();
			} else {
				throw proErr;
			}
		}

		const rawSdkHistory = chat.getHistory();
		const cleanHistory = sanitizeHistory(rawSdkHistory).slice(-HISTORY_LENGTH);
		await env.CHAT_KV.put(`chat_${chatId}_${threadId}`, JSON.stringify(cleanHistory), { expirationTtl: HISTORY_TTL });

		// Index conversation in Vectorize for semantic recall (fire-and-forget)
		if (userText && fullText) {
			vectorStore.indexConversation(env, userId, userText, fullText.slice(0, 200), messageId)
				.catch(e => console.error('Vectorize index error:', e.message));
		}

		// Index media in Vectorize for multimodal search (fire-and-forget)
		if (uploadedImageBase64 && uploadedImageMime && fullText) {
			vectorStore.indexMedia(env, userId, 'image', uploadedImageBase64, uploadedImageMime, fullText.slice(0, 200), messageId)
				.catch(e => console.error('Vectorize media index error:', e.message));
		}

		// Enrich bot message context with user text + persona for training pair collection.
		// When the user reacts with 👍/❤️, handleReactionFeedback can build a complete pair.
		if (lastSentMsgId && userText) {
			telegram.enrichMsgContext(chatId, lastSentMsgId, userText, effectivePersona, env)
				.catch(e => console.error('Enrich context error:', e.message));
		}

		// Check if user confirmed medication (clear the pending flag)
		const medPending = await env.CHAT_KV.get(`med_pending_${chatId}`);
		if (medPending && /\b(taken|took|yes|yep|yeah|done|had them|swallowed|popped)\b/i.test(userText)) {
			await env.CHAT_KV.delete(`med_pending_${chatId}`);
			log.info('med_confirmed_conversational', { chatId, period: medPending });
		}

		// Silent Observation: after substantive conversations, Xaridotis quietly reflects
		// on what it learned about the user implicitly (not just what was explicitly saved)
		if (userText.length > 30 && fullText.length > 50) {
			silentObservation(env, userId, chatId, userText, fullText).catch(e =>
				log.error('silent_observation_error', { msg: e.message })
			);
		}

		// DIAGNOSTICS: handler completed successfully — total time from message_received to here.
		// If we never see this log but we see message_received, we know the handler never reached
		// its exit point before waitUntil killed it.
		log.info('message_handled', {
			chatId,
			userId,
			provider: 'gemini',
			model: textModel,
			route_reason: route?.reason || 'gemini_default',
			ctxMode,
			inputLen: userText.length,
			outputLen: fullText.length,
			memCtx_chars: memCtx.length,
			memCtx_kept: (memCtxDebug.factual_kept || 0) + (memCtxDebug.therapeutic_kept || 0) + (memCtxDebug.feedback_kept || 0) + (memCtxDebug.triples_kept || 0),
			hasMedia,
			isEmotionalMsg,
			outcome: 'success',
			total_elapsed_ms: _elapsed(),
		});
		log.info('handler_end', { chatId, total_elapsed_ms: _elapsed(), outcome: 'success' });

	} catch (err) {
		console.error("❌ handleMessage crash:", err.message, err.stack);
		log.error('handler_end', { chatId, total_elapsed_ms: _elapsed(), outcome: 'crash', msg: err.message, stack: err.stack?.slice(0, 300) });
		try { await telegram.sendMessage(chatId, threadId, `⚠️ ${err.message?.slice(0, 150) || "Unknown error"}`, env, messageId, null, null, null, bizConnId); }
		catch (sendErr) { console.error("❌ Failed to send error msg:", sendErr.message); }
	}
}

export async function handleCallback(callbackQuery, env) {
	const chatId = callbackQuery.message.chat.id, threadId = callbackQuery.message.message_thread_id || "default";
	const userId = callbackQuery.from?.id;
	const data = callbackQuery.data, msgId = callbackQuery.message.message_id;
	log.info('callback', { chatId, data });

	try {
		await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ callback_query_id: callbackQuery.id })
		});

	if (data.startsWith("set_persona_")) {
		const key = data.replace("set_persona_", "");
		// Check built-in personas first, then user's custom personas in D1
		const isBuiltIn = !!personas[key];
		const userPersona = !isBuiltIn ? await personaStore.getPersona(env, userId, key) : null;
		if (isBuiltIn || userPersona) {
			await env.CHAT_KV.put(`persona_${chatId}_${threadId}`, key);
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			await telegram.sendChatAction(chatId, threadId, "typing", env);
			const displayName = userPersona?.display_name || personas[key]?.name || key;
			const instruction = userPersona?.custom_instruction || personas[personas[key] ? key : (userPersona?.base_persona || 'xaridotis')]?.instruction || personas.xaridotis.instruction;
			try {
				const greeting = await generateShortResponse(
					"The user just chose to talk to you. Greet them in 1-2 complete sentences in your distinct voice. Let them know you are here and ready.",
					instruction,
					env
				);
				await telegram.sendMessage(chatId, threadId, greeting, env, null, null, "5159385139981059251");
			} catch (e) {
				await telegram.sendMessage(chatId, threadId, `You are now talking to <b>${displayName}</b>.`, env);
			}
		}
	} else if (data === "confirm_forget") {
		await Promise.all([
			memoryStore.deleteAllMemories(env, userId),
			vectorStore.deleteAllVectors(env, userId),
		]);
		await telegram.editMessage(chatId, msgId, "🗑️ All memories deleted.", env);
	} else if (data === "cancel_forget") {
		await telegram.editMessage(chatId, msgId, "👍 Memories kept.", env);
	} else if (data.startsWith("set_model_")) {
		const mode = data.replace("set_model_", "");
		if (mode === "auto") {
			await env.CHAT_KV.delete(`model_override_${chatId}_${threadId}`);
			await telegram.editMessage(chatId, msgId, "✅ Model set to <b>Auto</b>.", env);
		} else {
			const targetModel = mode === "pro" ? PRIMARY_TEXT_MODEL : FALLBACK_TEXT_MODEL;
			await env.CHAT_KV.put(`model_override_${chatId}_${threadId}`, targetModel);
			await telegram.editMessage(chatId, msgId, `✅ Model manually set to <b>${mode.toUpperCase()}</b> for this chat.`, env);
		}
	} else if (data === "action_voice") {
		const botText = callbackQuery.message.text || "";
		if (botText) {
			const voicePersonaKey = getPersona(await env.CHAT_KV.get(`persona_${chatId}_${threadId}`));
			const voiceConfig = await personaStore.getPersona(env, userId, voicePersonaKey).catch(() => null);
			const voiceOverride = voiceConfig?.voice_name ? { voice: voiceConfig.voice_name, locale: voiceConfig.voice_locale || 'en-US' } : null;
			try {
				await telegram.sendChatAction(chatId, threadId, "upload_voice", env);
				const audio = await generateSpeech(botText, voicePersonaKey, env, voiceOverride);
				await telegram.sendVoice(chatId, threadId, audio, env, msgId);
			} catch (e) { console.error("Voice err:", e.message); }
		}
		await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
	} else if (data === "action_delete_msg") {
		await telegram.deleteMessage(chatId, msgId, env);
	} else if (data === 'architect_kill') {
		// Kill stuck architect run and clear the lock
		await env.CHAT_KV.delete(`architect_lock_${chatId}`);
		await telegram.editMessage(chatId, msgId, '⚙️ <b>Architecture review cancelled.</b> Run /architect to start fresh.', env);
		await telegram.answerCallbackQuery(callbackQuery.id, env, { text: 'Cancelled. Run /architect again.' }).catch(() => {});
	} else if (data === "action_dismiss_pr") {
		await telegram.editMessage(chatId, msgId, "<i>Architecture suggestion dismissed.</i>", env);
	} else if (data === "approve_pr") {
		// Extract the suggestion text from the message and send it to the chat as a new message
		// so Xaridotis can act on it with its tools (patch_repo_file etc.)
		const originalText = callbackQuery.message.text || '';
		await telegram.editMessage(chatId, msgId, `<b>Architecture Suggestion Approved</b>\n\n<i>Implementing...</i>`, env);
		// Feed the suggestion back to Xaridotis as an instruction to implement
		const fakeMsg = {
			message_id: msgId,
			chat: { id: chatId },
			from: callbackQuery.from,
			text: `I approve this architecture suggestion. Apply it now using patch_repo_file:\n\n${originalText.slice(0, 2000)}`,
			date: Math.floor(Date.now() / 1000),
		};
		await handleMessage(fakeMsg, env);
	} else if (data.startsWith('research_text_') || data.startsWith('research_audio_')) {
		const isAudio = data.startsWith('research_audio_');
		const num = parseInt(data.split('_').pop());
		const indexMap = await env.CHAT_KV.get(`research_list_${chatId}`, { type: 'json' });
		if (!indexMap || !indexMap[num]) {
			await telegram.answerCallbackQuery(callbackQuery.id, env, { text: 'List expired. Ask again.' }).catch(() => {});
			return;
		}
		const topic = indexMap[num];
		await telegram.answerCallbackQuery(callbackQuery.id, env, { text: isAudio ? '🔊 Generating audio...' : '📝 Loading...' }).catch(() => {});
		await telegram.sendChatAction(chatId, threadId, isAudio ? 'record_voice' : 'typing', env);

		const { searchResearchTool } = await import('../tools/research');
		const result = await searchResearchTool.execute(
			{ action: 'full', topic, index: num },
			env,
			{ chatId, threadId }
		);

		if (result.status !== 'success' || !result.report) {
			await telegram.sendMessage(chatId, threadId, `Could not retrieve the full report for "${topic}". ${result.message || ''}`, env);
			return;
		}

		if (isAudio) {
			// Generate voice using TTS
			const { voiceTool } = await import('../tools/voice');
			const voiceText = result.report.slice(0, 4000);
			await voiceTool.execute(
				{ text: voiceText },
				env,
				{ chatId, threadId, replyToMessageId: msgId }
			);
		} else {
			// Send as text with expandable blockquote for long reports
			const report = `<b>Research: ${topic}</b>\n\n<blockquote expandable>${result.report}</blockquote>`;
			const btns = { inline_keyboard: [[
				{ text: '🔊 Listen', callback_data: `research_audio_${num}` },
				{ text: '🗑️ Delete', callback_data: 'action_delete_msg' }
			]] };
			await sendLongMessage(chatId, threadId, report, env, null, btns);
		}
	} else if (data === 'noop') {
		// Separator row, do nothing
		await telegram.answerCallbackQuery(callbackQuery.id, env);
	} else if (data.startsWith("mchk|")) {
		// Mood checklist toggle
		const parts = data.split("|");
		const index = parseInt(parts[1]);
		const markup = callbackQuery.message.reply_markup;
		if (!markup?.inline_keyboard?.[index]?.[0]) return;
		const button = markup.inline_keyboard[index][0];
		if (button.text.startsWith("✅")) {
			button.text = `☐  ${button.text.replace(/^✅\s+/, "")}`;
		} else {
			button.text = `✅  ${button.text.replace(/^☐\s+/, "")}`;
		}

		// Count checked items for progress
		const checkableRows = markup.inline_keyboard.filter(row => row[0]?.callback_data?.startsWith('mchk|'));
		const checked = checkableRows.filter(row => row[0].text.startsWith('✅')).length;
		const total = checkableRows.length;
		const bar = '▓'.repeat(Math.round((checked / total) * 10)) + '░'.repeat(10 - Math.round((checked / total) * 10));

		const newText = `<b>Mood Check-in</b>\n\n${bar} ${checked}/${total} tracked\n\nTap each item to check it off, then select your mood score.\n\n🔴 <b>0-1:</b> Severe Depression\n🟠 <b>2-3:</b> Mild/Moderate\n🟢 <b>4-6:</b> Balanced\n🟡 <b>7-8:</b> Hypomania\n🔴 <b>9-10:</b> Mania`;
		await telegram.editMessage(chatId, msgId, newText, env, markup);

		// Save checked items to KV for later retrieval when mood score is submitted
		const checkedItems = checkableRows
			.filter(row => row[0].text.startsWith('✅'))
			.map(row => row[0].callback_data.split('|')[2]);
		await env.CHAT_KV.put(`mood_checklist_${chatId}`, JSON.stringify(checkedItems), { expirationTtl: 3600 });

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
	// ---- Medication and Mood callbacks from health check-ins ----
	else if (data.startsWith('mood_med_') || data.startsWith('mood_score_') || data.startsWith('mood_cat_') || data.startsWith('mood_emo')) {
		const today = moodStore.todayLondon();

		// Shared setup for med/score callbacks only
		if (data.startsWith('mood_med_') || data.startsWith('mood_score_')) {
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			await telegram.sendChatAction(chatId, threadId, "typing", env);
		}

		// Clear the nudge flag since the user responded
		const checkinType = data.includes('morning') ? 'morning' : data.includes('midday') ? 'midday' : 'evening';
		await env.CHAT_KV.delete(`nudge_pending_${checkinType}_${chatId}`);

		let contextPrompt = "";

		if (data === 'mood_med_yes_morning') {
			await moodStore.upsertEntry(env, userId, today, 'morning', { medication_taken: 1, medication_notes: 'Morning meds taken on time' });
			contextPrompt = "The user just confirmed they took their morning medication on time. Acknowledge this positively in one short sentence, then ask ONE natural follow-up question about how they slept last night. Do not ask anything else.";
		} else if (data === 'mood_med_no_morning') {
			await moodStore.upsertEntry(env, userId, today, 'morning', { medication_taken: 0, medication_notes: 'Morning meds not taken at check-in' });
			contextPrompt = "The user just said they haven't taken their morning medication yet. Gently remind them not to skip it, then ask ONE natural follow-up question about how they slept last night.";
		} else if (data === 'mood_med_yes_midday') {
			await moodStore.upsertEntry(env, userId, today, 'midday', { medication_taken: 1, medication_notes: 'ADHD + anxiety meds taken' });
			contextPrompt = "The user just confirmed they took their midday ADHD and anxiety medications. Acknowledge this, then ask ONE natural conversational question about how their day is going so far.";
		} else if (data === 'mood_med_partial_midday') {
			await moodStore.upsertEntry(env, userId, today, 'midday', { medication_taken: 1, medication_notes: 'ADHD only, anxiety not taken' });
			contextPrompt = "The user just confirmed they took their ADHD medication, but not their anxiety medication. Acknowledge this, remind them anxiety meds are there if they need them, and ask ONE conversational question about how their day is going.";
		} else if (data === 'mood_med_no_midday') {
			await moodStore.upsertEntry(env, userId, today, 'midday', { medication_taken: 0, medication_notes: 'Midday meds not taken' });
			contextPrompt = "The user hasn't taken their midday ADHD medication. Remind them gently that per NICE NG87 guidelines, taking it too late affects sleep, so they should take it soon. Then ask ONE conversational question about their day.";
		} else if (data.startsWith('mood_score_')) {
			const score = parseInt(data.split('_')[2]);
			const entry = await moodStore.upsertEntry(env, userId, today, 'evening', { mood_score: score });
			log.info('mood_score', { chatId, score });

			// Retrieve any checklist items that were ticked before the score was submitted
			const checklistRaw = await env.CHAT_KV.get(`mood_checklist_${chatId}`);
			const checkedItems = checklistRaw ? JSON.parse(checklistRaw) : [];
			if (checkedItems.length) {
				// Save checklist data alongside the mood entry
				await moodStore.upsertEntry(env, userId, today, 'evening', {
					med_morning: checkedItems.includes('med_morning'),
					med_adhd: checkedItems.includes('med_adhd'),
					med_anxiety: checkedItems.includes('med_anxiety'),
					exercise: checkedItems.includes('exercise'),
					meal: checkedItems.includes('meal'),
					sleep_quality: checkedItems.includes('sleep') ? 'good' : null,
				});
				await env.CHAT_KV.delete(`mood_checklist_${chatId}`);
			}

			const checklistSummary = checkedItems.length
				? `\nChecklist items completed: ${checkedItems.join(', ')}.`
				: '';

			if (score <= 1) {
				contextPrompt = `The user logged their mood as ${score}/10 (severe depression).${checklistSummary} Respond with deep compassion. Mention Samaritans (116 123) and SHOUT (text 85258). Then gently ask what has been weighing on them.`;
			} else if (score >= 9) {
				contextPrompt = `The user logged their mood as ${score}/10 (mania).${checklistSummary} Acknowledge calmly. Then ask ONE question about their safety or sleep.`;
			} else {
				contextPrompt = `The user logged their mood as ${score}/10 (${entry.mood_label || 'balanced'}).${checklistSummary} Acknowledge the score naturally and briefly. If they checked medication or exercise items, give a brief nod of recognition. Then tell them to tap one of the buttons below to start logging emotions.`;
			}

			try {
				const sysPrompt = personas.xaridotis.instruction;
				const response = await generateShortResponse(contextPrompt, sysPrompt, env);
				const aiMsg = response || 'Tap below to tell me about your emotions today.';
				log.info('mood_score_response_ready', { chatId, score, hasResponse: !!response, showButtons: score >= 2 && score <= 8 });

				// Always show emotion buttons for normal range scores (2-8)
				const btns = (score >= 2 && score <= 8) ? {
					inline_keyboard: [[
						{ text: '☀️ Positive', callback_data: 'mood_cat_positive', style: 'success' },
						{ text: '🌧 Negative', callback_data: 'mood_cat_negative', style: 'danger' }
					]]
				} : undefined;

				const sendRes = await telegram.sendMessage(chatId, threadId, aiMsg, env, null, btns);
				log.info('mood_score_message_sent', { chatId, ok: sendRes?.ok, hasButtons: !!btns });

				const histKey = `chat_${chatId}_${threadId}`;
				let hist = await env.CHAT_KV.get(histKey, { type: 'json' }) || [];
				hist.push({ role: 'model', parts: [{ text: aiMsg }] });
				if (hist.length > 24) hist = hist.slice(-24);
				await env.CHAT_KV.put(histKey, JSON.stringify(hist), { expirationTtl: 604800 });
			} catch (e) {
				log.error('mood_score_response', { msg: e.message, stack: e.stack?.slice(0, 300) });
				// Fallback: send buttons even if AI response fails
				await telegram.sendMessage(chatId, threadId, 'How are your emotions today?', env, null, {
					inline_keyboard: [[
						{ text: '☀️ Positive', callback_data: 'mood_cat_positive', style: 'success' },
						{ text: '🌧 Negative', callback_data: 'mood_cat_negative', style: 'danger' }
					]]
				});
			}

		} else if (data.startsWith('mood_cat_')) {
			const category = data.replace('mood_cat_', '');
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			log.info('mood_category', { chatId, category });

			await env.CHAT_KV.delete(`nudge_pending_evening_${chatId}`);

			const positiveEmotions = ['lively', 'grateful', 'proud', 'calm', 'relaxed', 'energetic', 'motivated', 'empathetic', 'inspired', 'curious', 'satisfied', 'excited', 'brave', 'confident', 'happy', 'joyful', 'carefree'];
			const negativeEmotions = ['devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed', 'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused', 'tired', 'bored', 'nervous', 'disappointed', 'lost'];

			// Show whichever category they tapped first
			const firstList = category === 'positive' ? positiveEmotions : negativeEmotions;
			const otherCategory = category === 'positive' ? 'negative' : 'positive';

			const rows = [];
			for (let i = 0; i < firstList.length; i += 3) {
				rows.push(firstList.slice(i, i + 3).map(e => ({
					text: e, callback_data: `mood_emo_${e}`
				})));
			}
			rows.push([{ text: `➡️ Next: ${otherCategory} emotions`, callback_data: `mood_emo_next_${otherCategory}` }]);
			rows.push([{ text: '✅ Done (skip the rest)', callback_data: 'mood_emo_done' }]);

			await env.CHAT_KV.put(`mood_emo_selected_${chatId}`, '[]', { expirationTtl: 3600 });

			await telegram.sendMessage(chatId, threadId,
				`<b>Select all ${category} emotions that resonate.</b>\nTap each one, then ➡️ Next or ✅ Done.`,
				env, null, { inline_keyboard: rows });

		} else if (data.startsWith('mood_emo_next_')) {
			const nextCategory = data.replace('mood_emo_next_', '');
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);

			const positiveEmotions = ['lively', 'grateful', 'proud', 'calm', 'relaxed', 'energetic', 'motivated', 'empathetic', 'inspired', 'curious', 'satisfied', 'excited', 'brave', 'confident', 'happy', 'joyful', 'carefree'];
			const negativeEmotions = ['devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed', 'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused', 'tired', 'bored', 'nervous', 'disappointed', 'lost'];

			const list = nextCategory === 'positive' ? positiveEmotions : negativeEmotions;

			const rows = [];
			for (let i = 0; i < list.length; i += 3) {
				rows.push(list.slice(i, i + 3).map(e => ({
					text: e, callback_data: `mood_emo_${e}`
				})));
			}
			rows.push([{ text: '✅ Done selecting', callback_data: 'mood_emo_done' }]);

			await telegram.sendMessage(chatId, threadId,
				`<b>Now select any ${nextCategory} emotions.</b>\nTap each one, then ✅ Done.`,
				env, null, { inline_keyboard: rows });

		} else if (data.startsWith('mood_emo_') && data !== 'mood_emo_done' && !data.startsWith('mood_emo_next_')) {
			// Individual emotion selection - toggle and acknowledge
			const emotion = data.replace('mood_emo_', '');
			const selectedStr = await env.CHAT_KV.get(`mood_emo_selected_${chatId}`) || '[]';
			const selected = JSON.parse(selectedStr);

			if (selected.includes(emotion)) {
				selected.splice(selected.indexOf(emotion), 1);
			} else {
				selected.push(emotion);
			}
			await env.CHAT_KV.put(`mood_emo_selected_${chatId}`, JSON.stringify(selected), { expirationTtl: 3600 });

			await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ callback_query_id: callbackQuery.id, text: selected.includes(emotion) ? `✓ ${emotion}` : `✗ ${emotion} removed`, show_alert: false })
			});

		} else if (data === 'mood_emo_done') {
			await telegram.editMessageReplyMarkup(chatId, msgId, null, env);
			await telegram.sendChatAction(chatId, threadId, 'typing', env);

			const selectedStr = await env.CHAT_KV.get(`mood_emo_selected_${chatId}`) || '[]';
			const selected = JSON.parse(selectedStr);

			// Save all emotions to mood journal
			const today = moodStore.todayLondon();
			if (selected.length > 0) {
				await moodStore.upsertEntry(env, userId, today, 'evening', { emotions: JSON.stringify(selected) });
				log.info('mood_emotions_logged', { userId, emotions: selected });

				// Background: auto-tag mood entry with clinical categories (CF AI, free)
				import('../services/cfAi').then(async ({ tagMoodEntry }) => {
				const todayEntry = await moodStore.getEntry(env, userId, today, 'evening').catch(() => null);
					const parsed = todayEntry?.data ? (typeof todayEntry.data === 'string' ? JSON.parse(todayEntry.data) : todayEntry.data) : {};
					const tags = await tagMoodEntry(env, parsed.mood_score, selected, parsed.note);
					if (tags) {
						await moodStore.upsertEntry(env, userId, today, 'evening', { clinical_tags: tags });
						log.info('mood_tagged', { userId, tags });
					}
				}).catch(e => console.error('Mood tagging error:', e.message));
			}

			// Clean up KV
			await env.CHAT_KV.delete(`mood_emo_selected_${chatId}`);

			// Separate into positive and negative for Nightfall's context
			const negativeList = ['devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed', 'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused', 'tired', 'bored', 'nervous', 'disappointed', 'lost'];
			const negSelected = selected.filter(e => negativeList.includes(e));
			const posSelected = selected.filter(e => !negativeList.includes(e));

			// Pull recent mood history for context (last 30 days)
			const recentEntries = await moodStore.getHistory(env, userId, 30, 'evening').catch(() => []);
			let pastContext = 'No previous check-ins found.';
			if (recentEntries.length > 1) {
				const summaries = recentEntries.slice(0, 10).map(e => {
					const parsed = typeof e.data === 'string' ? JSON.parse(e.data || '{}') : (e.data || {});
					return `${e.date}: score ${parsed.mood_score ?? '?'}, emotions: ${parsed.emotions || 'none'}`;
				}).join(' | ');
				pastContext = `Recent evening check-ins (up to 30 days): ${summaries}`;
			}

			// Pull therapeutic notes for clinical depth
			const therapeuticNotes = await env.DB.prepare(
				`SELECT category, fact FROM memories WHERE user_id = ? AND category IN ('pattern','trigger','schema','insight','homework','growth') ORDER BY created_at DESC LIMIT 10`
			).bind(userId).all().then(r => r.results || []).catch(() => []);
			const clinicalCtx = therapeuticNotes.length
				? 'Clinical notes:\n' + therapeuticNotes.map(n => `[${n.category}] ${n.fact}`).join('\n')
				: '';

			// Pull semantic context related to their current emotions
			const emotionQuery = [...negSelected, ...posSelected].join(' ') || 'mood emotions feelings';
			const semanticCtx = await vectorStore.getSemanticContext(env, userId, emotionQuery).catch(() => '');

			// Pull relevant past episodes (CoALA episodic memory)
			const allEmotions = [...negSelected, ...posSelected];
			const relevantEpisodes = allEmotions.length
				? await episodeStore.getEpisodesByEmotion(env, userId, allEmotions, 5).catch(() => [])
				: await episodeStore.getRecentEpisodes(env, userId, 5).catch(() => []);
			const episodeCtx = episodeStore.formatEpisodesForContext(relevantEpisodes);

			// Today's mood score (pull from the entry we just updated)
			const todayEntry = await moodStore.getEntry(env, userId, today, 'evening').catch(() => null);
			const todayParsed = todayEntry?.data ? (typeof todayEntry.data === 'string' ? JSON.parse(todayEntry.data) : todayEntry.data) : {};
			const todayScore = todayParsed.mood_score;

			const contextPrompt = `The user just completed their full mood check-in. Analyse everything and give a meaningful therapeutic summary.

TODAY'S CHECK-IN:
Mood score: ${todayScore ?? 'not recorded'}/10
Positive emotions: ${posSelected.length > 0 ? posSelected.join(', ') : 'none selected'}
Negative emotions: ${negSelected.length > 0 ? negSelected.join(', ') : 'none selected'}

RECENT MOOD HISTORY:
${pastContext}

${clinicalCtx}

${episodeCtx}

${semanticCtx}

YOUR RESPONSE (follow this structure naturally, not as a list):
1. Acknowledge what they shared today. Name the emotions they selected. If the mix of positive and negative is notable (e.g. "inspired but lonely"), explore that tension.
2. Compare to recent days. Is the score trending up, down, or stable? Are certain emotions recurring? Note any patterns without being clinical.
3. If past episodes are available, reference what happened in similar emotional states before. What helped? What didn't? Use this to inform your suggestion.
4. Draw one therapeutic observation. Connect today's emotions to known patterns, triggers, or schemas from the clinical notes. Use therapeutic frameworks (AEDP, IFS, schema therapy) as lenses for YOUR thinking — do NOT name them to the user.
5. End with ONE natural question that invites deeper conversation but doesn't pressure.

Keep it warm, direct, and personal. 3-5 sentences. No bullet points. No clinical jargon unless it adds genuine insight. You know this person well.`;

			try {
				// Pro + high thinking for therapeutic synthesis (matching Eukara's pattern).
				// This is the deepest call in the mood flow — quality matters more than speed.
				const response = await generateDeepResponse(contextPrompt, personas.xaridotis.instruction, env, {
					thinkingLevel: 'high',
					maxOutputTokens: 2000,
				});
				const synthesis = response || `Thank you for sharing. What has been on your mind today?`;
				await telegram.sendMessage(chatId, threadId, synthesis, env);

				// Persist BOTH the synthetic user turn and the synthesis in history.
				// This gives follow-up messages context about the check-in without
				// re-encoding the button flow as conversation.
				const selectionLabel = selected.length
					? `[I finished my check-in. Selected emotions: ${selected.join(', ')}]`
					: `[I finished my check-in without selecting specific emotions]`;
				const histKey = `chat_${chatId}_${threadId}`;
				let hist = await env.CHAT_KV.get(histKey, { type: 'json' }) || [];
				hist.push({ role: 'user', parts: [{ text: selectionLabel }] });
				hist.push({ role: 'model', parts: [{ text: synthesis }] });
				if (hist.length > 24) hist = hist.slice(-24);
				await env.CHAT_KV.put(histKey, JSON.stringify(hist), { expirationTtl: 604800 });

				// Clear the check-in active flag — the flow is complete
				await env.CHAT_KV.delete(`health_checkin_active_${chatId}`);

				log.info('mood_synthesis_sent', { userId, emotionsCount: selected.length, synthesisLen: synthesis.length });
			} catch (e) {
				log.error('mood_emotion_response', { msg: e.message });
				await telegram.sendMessage(chatId, threadId, `You selected: ${selected.join(', ')}. What has been driving those feelings?`, env);
			}
		}

		// Generate dynamic response for MEDICATION callbacks only (mood_score and mood_cat handle their own)
		if (data.startsWith('mood_med_') && contextPrompt) {
			try {
				const sysPrompt = personas.xaridotis.instruction;
				const response = await generateShortResponse(contextPrompt, sysPrompt, env);
				const aiMsg = response || 'How are you feeling right now?';
				await telegram.sendMessage(chatId, threadId, aiMsg, env);

				const histKey = `chat_${chatId}_${threadId}`;
				let hist = await env.CHAT_KV.get(histKey, { type: 'json' }) || [];
				hist.push({ role: 'model', parts: [{ text: aiMsg }] });
				if (hist.length > 24) hist = hist.slice(-24);
				await env.CHAT_KV.put(histKey, JSON.stringify(hist), { expirationTtl: 604800 });
			} catch (e) {
				console.error('Health callback AI error:', e.message, e.stack);
				await telegram.sendMessage(chatId, threadId, 'Noted. How are you feeling right now?', env);
			}
		}
	}
	} catch (err) {
		console.error('❌ handleCallback crash:', err.message, err.stack);
		try { await telegram.sendMessage(chatId, threadId, `⚠️ ${err.message?.slice(0, 150)}`, env); }
		catch (e) { console.error('❌ Failed to send callback error:', e.message); }
	}
}
