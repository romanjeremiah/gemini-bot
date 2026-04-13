import { personas, FORMATTING_RULES, MENTAL_HEALTH_DIRECTIVE, SECOND_BRAIN_DIRECTIVE } from '../config/personas';
import { createChat, sendChatMessage, sendChatMessageStream, generateImage, setupCache, PRIMARY_TEXT_MODEL, FALLBACK_TEXT_MODEL, generateShortResponse, generateWithFallback } from '../lib/ai/gemini';
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
import { getAllSchedules, setSchedule, resetSchedule } from '../config/schedules';
import { log } from '../lib/logger';

const HISTORY_LENGTH = 24;
const HISTORY_TTL = 604800;
const DRAFT_THROTTLE_MS = 500; // minimum ms between sendMessageDraft calls

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework'];

/**
 * Detect whether a message requires the Pro model (complex reasoning)
 * or can be handled by Flash (casual conversation, simple questions).
 *
 * Pro triggers:
 * - Code/architecture discussions (mentions code, file paths, functions, debugging)
 * - Mental health conversations (active check-in, emotional language, therapy terms)
 * - Complex requests (analysis, comparison, deep explanation, research)
 * - Tool-heavy requests (reminders with complex timing, image generation prompts)
 *
 * Flash handles:
 * - Casual chat, greetings, small talk
 * - Simple questions, quick lookups
 * - Short responses, confirmations
 */
function detectComplexTask(text, activeCheckin) {
	if (!text) return false;
	const lower = text.toLowerCase();

	// Active health check-in always uses Pro
	if (activeCheckin) return true;

	// Code/technical patterns
	if (/\b(code|function|bug|error|deploy|refactor|implement|architecture|PR|pull request|commit|git|webpack|npm|wrangler|api|endpoint|database|query|sql|schema|migration)\b/i.test(text)) return true;
	if (/\.(js|ts|py|json|css|html|jsx|mjs)\b/.test(text)) return true;
	if (/```/.test(text)) return true;

	// Mental health / emotional depth
	if (/\b(anxious|depressed|panic|overwhelm|trigger|dissociat|suicid|self.?harm|therapy|therapist|schema|attachment|ifs|dbt|aedp|emotion|mood|bipolar|mania|hypo)\b/i.test(text)) return true;

	// Complex requests
	if (/\b(analyse|analyze|compare|explain.*detail|research|deep dive|break down|pros and cons|trade.?off|strategy|plan)\b/i.test(text)) return true;

	// Long messages (>300 chars) likely need deeper reasoning
	if (text.length > 300) return true;

	// Default: Flash is sufficient
	return false;
}

// Silent Observation: Xaridotis quietly reflects on conversations to learn about the user
// implicitly. Runs in the background after substantive exchanges. Throttled to max 5/day.
async function silentObservation(env, chatId, userText, botResponse) {
	// Throttle: max 5 observations per day
	const today = new Date().toISOString().split('T')[0];
	const countKey = `observation_count_${chatId}_${today}`;
	const count = parseInt(await env.CHAT_KV.get(countKey) || '0');
	if (count >= 5) return;

	try {
		const response = await generateShortResponse(
			`You just had this exchange with the user:

USER: ${userText.slice(0, 500)}
YOU: ${botResponse.slice(0, 300)}

Quietly reflect: did you learn anything NEW about this person that is worth remembering? This could be:
- An implicit preference they did not state directly (e.g. they always ask about food when stressed)
- A behavioural pattern (e.g. they message late at night when anxious)
- A new interest, goal, or life event they mentioned in passing
- An emotional pattern (e.g. they deflect with humour when discussing relationships)
- Something that changed from what you previously knew

If you noticed something worth saving, respond with ONLY a single concise observation starting with "OBSERVATION:" (e.g. "OBSERVATION: User tends to message about coding when avoiding emotional topics").
If nothing new was learned, respond with exactly: NOTHING_NEW`,
			'You are a silent observer. Be concise. Only note genuinely new implicit information, not obvious facts already stated.',
			env
		);

		if (response && response.startsWith('OBSERVATION:')) {
			const observation = response.replace('OBSERVATION:', '').trim();
			if (observation.length > 10) {
				await memoryStore.saveMemory(env, chatId, 'insight', `Implicit: ${observation}`, 1, chatId);
				await env.CHAT_KV.put(countKey, String(count + 1), { expirationTtl: 86400 });
				log.info('silent_observation', { chatId, observation: observation.slice(0, 80) });
			}
		}
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
async function getCheckinRoadmap(env, chatId) {
	const todayLondon = moodStore.todayLondon();
	const entry = await moodStore.getEntry(env, chatId, todayLondon, 'evening');
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
			await telegram.sendMessage(chatId, threadId, `Hey. I am <b>Xaridotis</b>.\n\nSend a message, voice note, photo, or document to begin.\n\n<b>Commands:</b>\n/mood — Interactive mood check-in\n/listen — Deep listening mode\n/architect — Architecture review\n/schedule — View schedules\n/memories — View saved facts\n/clear — Fresh start\n/forget — Delete all memories`, env);
			return true;
		}
		case "/persona":
			await telegram.sendMessage(chatId, threadId, "You are talking to <b>Xaridotis</b>. I adapt my tone naturally based on the conversation. No switching needed.\n\nIf you want to explicitly set a tone, just tell me: \"be direct\" or \"be gentle\".", env);
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
			// Safety: split into chunks if still too long
			const footer = "<i>Use /forget to clear all.</i>";
			if (t.length + footer.length > 4000) {
				t = t.slice(0, 3900) + "\n\n<i>...truncated. Too many memories to display.</i>\n";
			}
			await telegram.sendMessage(chatId, threadId, t + footer, env);
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

			// Send mood poll (0-10 bipolar scale)
			const moodOptions = [
				'0: Crisis. Suicidal thoughts, total despair.',
				'1: Severe. Hopeless, guilt, can\'t function.',
				'2: Low. Persistent sadness, withdrawn.',
				'3: Struggling. Anxious, irritable.',
				'4: Below average. Flat, low energy.',
				'5: Neutral. Steady baseline.',
				'6: Good. Positive, engaged.',
				'7: Very good. Productive, optimistic.',
				'8: Elevated. Racing thoughts, less sleep.',
				'9: Hypomanic. Impulsive, grandiose.',
				'10: Manic. Reckless, detached.',
			];

			const pollRes = await telegram.sendPoll(chatId, threadId,
				'How do you feel right now?',
				moodOptions,
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
		case "/researchhistory": {
			if (!env.OWNER_ID || String(msg.from.id) !== String(env.OWNER_ID)) {
				await telegram.sendMessage(chatId, threadId, "This command is owner-only.", env);
				return true;
			}
			try {
				const { results } = await env.DB.prepare(
					`SELECT fact, category, created_at FROM memories WHERE chat_id = ? AND fact LIKE 'Deep Research%' ORDER BY created_at DESC LIMIT 10`
				).bind(chatId).all();

				if (!results?.length) {
					await telegram.sendMessage(chatId, threadId, "No deep research results found yet. Use <code>/research your topic</code> to start one.", env);
					return true;
				}

				let text = `<b>Deep Research History</b> (${results.length} results)\n\n`;
				for (const r of results) {
					const date = new Date(r.created_at + 'Z').toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
					const topicMatch = r.fact.match(/^Deep Research \(([^)]+)\):/);
					const topic = topicMatch ? topicMatch[1] : 'Unknown';
					const summary = r.fact.replace(/^Deep Research \([^)]+\):\s*/, '').slice(0, 200);
					text += `<b>${date}</b> [${r.category}]\n<i>${topic}</i>\n${summary}${summary.length >= 200 ? '...' : ''}\n\n`;
				}

				// Safety: truncate if too long for Telegram
				if (text.length > 4000) text = text.slice(0, 3900) + '\n\n<i>...truncated</i>';
				await telegram.sendMessage(chatId, threadId, text, env);
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

			const statusRes = await telegram.sendMessage(chatId, threadId, "⚙️ <b>Architecture Review</b>\n<i>Phase 1: Initialising search parameters...</i>", env);
			const statusMsgId = statusRes?.result?.message_id;

			try {
				const { ARCHITECTURE_SUMMARY } = await import('../config/architecture.js');

				if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, "⚙️ <b>Architecture Review</b>\n<i>Phase 2: Querying trusted sources and documentation...</i>", env);

				const { text: suggestions } = await generateWithFallback(env,
					[{ role: 'user', parts: [{ text: `You are a senior AI product strategist and innovation researcher. You are reviewing a Telegram AI companion chatbot called Xaridotis (TenonMind). Your mission is to find cutting-edge capabilities and ideas that would make this bot genuinely unique in the market.

CURRENT ARCHITECTURE:
${ARCHITECTURE_SUMMARY}

COMPREHENSIVE RESEARCH TASK:

1. PLATFORM CAPABILITIES (search for the absolute latest):
   - Telegram Bot API: new methods, Mini Apps, business features, checklists, payments, inline mode, reactions, stories
   - Google Gemini API: new models, Interactions API, Live API, Deep Research, multimodal embeddings, code execution, video/music generation, TTS, robotics
   - Google Cloud / Vertex AI: new services, agent frameworks (ADK), grounding, evaluation tools
   - Cloudflare: Workers AI models, Workflows, D1, Vectorize, Browser Rendering, Durable Objects, Queues, AI Gateway
   - OpenAI API: any new features or patterns worth adapting (function calling patterns, structured outputs, real-time API)
   - Anthropic Claude API: MCP (Model Context Protocol), tool use patterns, computer use

2. AI COMPANION & THERAPEUTIC RESEARCH:
   - Latest research on AI-assisted mental health support (NHS Digital, NICE guidelines, APA, WHO)
   - Therapeutic AI frameworks: AEDP, DBT, IFS, Schema Therapy, Attachment Theory innovations
   - Ethical AI companion design: what makes interactions feel authentic vs manipulative
   - Neurodivergence support: ADHD, autism, bipolar, executive function aids
   - Behavioural change and habit formation science

3. COMPETITOR AND MARKET ANALYSIS:
   - AI companions: Pi (Inflection), Replika, Character.ai, Nomi, Kindroid
   - AI assistants: ChatGPT (memory, voice, canvas), Claude (artifacts, MCP), Gemini (extensions, Live)
   - Therapeutic chatbots: Woebot, Wysa, Youper
   - Productivity AI: Notion AI, Obsidian Copilot, Mem.ai, Granola
   - What features are users asking for that nobody has built yet?

4. EMERGING TECHNOLOGY:
   - Voice AI: real-time conversation, emotion detection, prosody analysis
   - Wearable integration: Apple Watch health data, sleep tracking APIs
   - Ambient computing: proactive AI that acts without being asked
   - Personal knowledge management: second brain, Zettelkasten, spaced repetition
   - Multi-agent systems: can Xaridotis coordinate with other AI agents?

5. UNIQUENESS FILTER (apply to every suggestion):
   - Would a user switch from ChatGPT/Pi to this bot because of this feature?
   - Does it leverage the unique combination of Telegram + Gemini + Cloudflare in a way competitors cannot replicate?
   - Does it serve the core mission: genuine AI friendship with therapeutic depth?
   - Is it feasible with the current tech stack, or does it require reasonable additions?

OUTPUT: Propose exactly 3 HIGH-IMPACT innovations. For each:
   a) What is it and why is it genuinely unique
   b) How it differs from what any competitor offers
   c) Concrete implementation sketch (files, APIs, estimated effort in days)
   d) Why it matters for the user's mental health, productivity, or daily life
   e) What makes this a "must-have" not a "nice-to-have"

Be bold. Think beyond incremental improvements. Reference actual file paths from the architecture.` }] }],
					{ tools: [{ googleSearch: {} }], temperature: 0.7 }
				);

				if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, "⚙️ <b>Architecture Review</b>\n<i>Phase 3: Analysing gaps and drafting suggestions...</i>", env);

				if (!suggestions || suggestions.length < 100) {
					if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, "⚙️ <b>Architecture Review</b>\n<i>Could not generate suggestions. Try again later.</i>", env);
					return true;
				}

				const today = new Date().toISOString().split('T')[0];
				await memoryStore.saveMemory(env, chatId, 'discovery', `Architect review (${today}): ${suggestions.slice(0, 500)}`, 1, chatId);

				if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, "⚙️ <b>Architecture Review</b>\n<i>Phase 4: Formatting final response...</i>", env);

				const pKey = getPersona(await env.CHAT_KV.get(`persona_${chatId}_${threadId}`));
				const persona = personas[pKey];
				const formatted = await generateShortResponse(
					`Rewrite these technical suggestions as a casual message sharing ideas about how to improve the bot. Keep your personality. Present each as something you noticed while doing research. 3-4 paragraphs.\n\nRaw:\n${suggestions}`,
					persona.instruction, env
				);

				if (statusMsgId) {
					await telegram.editMessage(chatId, statusMsgId, `<b>Architecture Review</b>\n\n${formatted || suggestions.slice(0, 2000)}`, env);
				} else {
					await telegram.sendMessage(chatId, threadId, `<b>Architecture Review</b>\n\n${formatted || suggestions.slice(0, 2000)}`, env);
				}
			} catch (e) {
				console.error('Architect error:', e.message);
				if (statusMsgId) await telegram.editMessage(chatId, statusMsgId, `⚙️ <b>Architecture Review Failed</b>\n<i>${e.message?.slice(0, 100)}</i>`, env);
				else await telegram.sendMessage(chatId, threadId, `Architecture review failed: ${e.message?.slice(0, 100)}`, env);
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
	const replyToMessageId = msg.reply_to_message?.message_id || null;

	// Skip messages from bots (including our own)
	if (msg.from?.is_bot) return;

	try {
		const firstName = msg.from.first_name || "User", userText = msg.text || msg.caption || "";
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
			const timestamp = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London' });
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

		await telegram.sendChatAction(chatId, threadId, "typing", env);

		// Dynamic context throttling: skip heavy D1/Vectorize queries for short, low-value replies
		const hasMedia = !!getMediaFromMessage(msg);
		const isSubstantive = userText.length > 15 || userText.includes('?') || hasMedia;

		const [memCtx, semanticCtx, personaKey, rawHistory] = await Promise.all([
			isSubstantive ? memoryStore.getFormattedContext(env, chatId) : Promise.resolve(''),
			isSubstantive ? vectorStore.getSemanticContext(env, chatId, userText) : Promise.resolve(''),
			env.CHAT_KV.get(`persona_${chatId}_${threadId}`),
			env.CHAT_KV.get(`chat_${chatId}_${threadId}`, { type: "json" })
		]);

		const activePersona = getPersona(personaKey);
		const hist = sanitizeHistory(rawHistory || []);

		// Model routing: check for manual override in KV, otherwise default to Owner=Pro / Guest=Flash
		const isOwner = env.OWNER_ID && String(msg.from.id) === String(env.OWNER_ID);
		const modelOverride = await env.CHAT_KV.get(`model_override_${chatId}_${threadId}`);
		// Smart model selection: Pro for complex tasks, Flash for casual conversation
		let textModel = modelOverride || FALLBACK_TEXT_MODEL; // Default: Flash for everyone
		if (isOwner && !modelOverride) {
			const needsPro = detectComplexTask(userText, activeCheckin);
			textModel = needsPro ? PRIMARY_TEXT_MODEL : FALLBACK_TEXT_MODEL;
			if (needsPro) log.info('model_upgrade', { reason: 'complex_task', model: textModel });
		}

		// Unified persona: Xaridotis handles all tones naturally
		const healthCheckin = isOwner ? await env.CHAT_KV.get(`health_checkin_active_${chatId}`) : null;
		const effectivePersona = 'xaridotis';

		// If the user is clearly NOT engaging with a health check-in, clear the flag
		// so it doesn't pollute unrelated conversations
		const isHealthRelated = /sleep|mood|medication|medic|anxious|anxiety|depressed|how.*feel|emotion|check.?in/i.test(userText);
		if (healthCheckin && !isHealthRelated && userText.length > 10) {
			await env.CHAT_KV.delete(`health_checkin_active_${chatId}`);
			log.info('checkin_cleared', { chatId, reason: 'non_health_message', was: healthCheckin });
		}

		// Only inject check-in context if the flag survived (user is still engaging with health)
		const activeCheckin = await env.CHAT_KV.get(`health_checkin_active_${chatId}`);

		// Build dynamic journal roadmap for evening check-ins
		let checkinProgress = '';
		if (activeCheckin === 'evening') {
			const roadmap = await getCheckinRoadmap(env, chatId);
			if (roadmap.includes('All data collected')) {
				checkinProgress = ` | ${roadmap}`;
				env.CHAT_KV.delete(`health_checkin_active_${chatId}`);
			} else {
				checkinProgress = ` | ${roadmap}`;
			}
		} else if (activeCheckin) {
			checkinProgress = ` | HEALTH CHECK-IN MODE (${activeCheckin}): Conduct the ${activeCheckin} check-in naturally. Use log_mood_entry to record data. If the user changes topic, drop the check-in and help with their request instead.`;
		}

		let replyContext = "";
		if (msg.reply_to_message) replyContext = `\n[User is replying to ${msg.reply_to_message.from?.first_name || "Someone"}: "${(msg.reply_to_message.text || msg.reply_to_message.caption || "").slice(0, 500)}"]\n`;

		const personaInstruction = personas[effectivePersona].instruction;
		const weatherCtx = await getWeatherContext(env);

		// Familiarity Index: track relationship length
		let firstSeen = await env.CHAT_KV.get(`first_seen_${chatId}`);
		if (!firstSeen) {
			firstSeen = String(Date.now());
			await env.CHAT_KV.put(`first_seen_${chatId}`, firstSeen);
		}
		const daysKnown = Math.floor((Date.now() - parseInt(firstSeen)) / 86400000);

		const dynamicContext = `[Context] Current speaker: ${userIdentity} | London Time: ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })} | Unix: ${Math.floor(Date.now() / 1000)}${weatherCtx ? ` | ${weatherCtx}` : ''} | Relationship: ${daysKnown} days${checkinProgress}\n\nMEMORY:\n${memCtx}${semanticCtx}`;

		// Skip code execution when media is present (incompatible with audio/video inline data)
		// Also skip cache when media is present, because the cache has codeExecution baked in
		const cacheContext = hasMedia ? null : await setupCache(personaInstruction, FORMATTING_RULES, dynamicContext, env, textModel);
		const fullSysPrompt = `${personaInstruction}\n\n${MENTAL_HEALTH_DIRECTIVE}\n\n${SECOND_BRAIN_DIRECTIVE}\n\n${FORMATTING_RULES}\n${dynamicContext}`;

		let chat;
		try {
			chat = await createChat(hist, fullSysPrompt, env, cacheContext, textModel, { skipCodeExecution: hasMedia });
		} catch (cacheErr) {
			// If cache is stale (403), retry without cache
			if (cacheErr.message?.includes('403') || cacheErr.message?.includes('CachedContent')) {
				log.warn('cache_stale_retry', { msg: cacheErr.message });
				chat = await createChat(hist, fullSysPrompt, env, null, textModel, { skipCodeExecution: hasMedia });
			} else {
				throw cacheErr;
			}
		}

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

		// Index media in Vectorize for multimodal search (fire-and-forget)
		if (uploadedImageBase64 && uploadedImageMime && fullText) {
			vectorStore.indexMedia(env, chatId, 'image', uploadedImageBase64, uploadedImageMime, fullText.slice(0, 200), messageId)
				.catch(e => console.error('Vectorize media index error:', e.message));
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
			silentObservation(env, chatId, userText, fullText).catch(e =>
				log.error('silent_observation_error', { msg: e.message })
			);
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
	log.info('callback', { chatId, data });

	try {
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
		} else if (data.startsWith('mood_score_')) {
			const score = parseInt(data.split('_')[2]);
			const entry = await moodStore.upsertEntry(env, chatId, today, 'evening', { mood_score: score });
			log.info('mood_score', { chatId, score });

			// Retrieve any checklist items that were ticked before the score was submitted
			const checklistRaw = await env.CHAT_KV.get(`mood_checklist_${chatId}`);
			const checkedItems = checklistRaw ? JSON.parse(checklistRaw) : [];
			if (checkedItems.length) {
				// Save checklist data alongside the mood entry
				await moodStore.upsertEntry(env, chatId, today, 'evening', {
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
				await moodStore.upsertEntry(env, chatId, today, 'evening', { emotions: JSON.stringify(selected) });
				log.info('mood_emotions_logged', { chatId, emotions: selected });
			}

			// Clean up KV
			await env.CHAT_KV.delete(`mood_emo_selected_${chatId}`);

			// Separate into positive and negative for Nightfall's context
			const negativeList = ['devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed', 'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused', 'tired', 'bored', 'nervous', 'disappointed', 'lost'];
			const negSelected = selected.filter(e => negativeList.includes(e));
			const posSelected = selected.filter(e => !negativeList.includes(e));

			// Pull recent mood history for context (last 30 days)
			const recentEntries = await moodStore.getHistory(env, chatId, 30, 'evening').catch(() => []);
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
				`SELECT category, fact FROM memories WHERE chat_id = ? AND category IN ('pattern','trigger','schema','insight','homework','growth') ORDER BY created_at DESC LIMIT 10`
			).bind(chatId).all().then(r => r.results || []).catch(() => []);
			const clinicalCtx = therapeuticNotes.length
				? 'Clinical notes:\n' + therapeuticNotes.map(n => `[${n.category}] ${n.fact}`).join('\n')
				: '';

			// Pull semantic context related to their current emotions
			const emotionQuery = [...negSelected, ...posSelected].join(' ') || 'mood emotions feelings';
			const semanticCtx = await vectorStore.getSemanticContext(env, chatId, emotionQuery).catch(() => '');

			// Today's mood score (pull from the entry we just updated)
			const todayEntry = await moodStore.getEntry(env, chatId, today, 'evening').catch(() => null);
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

${semanticCtx}

YOUR RESPONSE (follow this structure naturally, not as a list):
1. Acknowledge what they shared today. Name the emotions they selected. If the mix of positive and negative is notable (e.g. "inspired but lonely"), explore that tension.
2. Compare to recent days. Is the score trending up, down, or stable? Are certain emotions recurring? Note any patterns without being clinical.
3. Draw one therapeutic observation. Connect today's emotions to known patterns, triggers, or schemas from the clinical notes. Use AEDP/IFS language gently (e.g. "sounds like a protector part is active" or "there might be some unprocessed grief underneath the boredom").
4. End with ONE natural question that invites deeper conversation but doesn't pressure. Something like "What do you think is driving the loneliness today?" not "Would you like to explore this further?"

Keep it warm, direct, and personal. 3-5 sentences. No bullet points. No clinical jargon unless it adds genuine insight. You know this person well.`;

			try {
				const response = await generateShortResponse(contextPrompt, personas.xaridotis.instruction, env);
				await telegram.sendMessage(chatId, threadId, response || `Thank you for sharing. What has been on your mind today?`, env);

				const histKey = `chat_${chatId}_${threadId}`;
				let hist = await env.CHAT_KV.get(histKey, { type: 'json' }) || [];
				hist.push({ role: 'model', parts: [{ text: response }] });
				if (hist.length > 24) hist = hist.slice(-24);
				await env.CHAT_KV.put(histKey, JSON.stringify(hist), { expirationTtl: 604800 });
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
