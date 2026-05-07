// End-of-flow mood check-in synthesis.
//
// Fires once at the END of a mood check-in, after all data is collected
// (score, emotions, activities, sleep, photo-or-skipped). This is the ONE
// AI call per check-in that earns Pro-tier resilience: it produces the
// therapeutic observation that connects today's data to past patterns.
//
// Cascade (Cloudflare-first, Gemini fallback):
//   Tier 1: @cf/meta/llama-3.3-70b-instruct-fp8-fast  (15s)
//   Tier 2: @cf/google/gemma-3-12b-it                 (15s)
//   Tier 3: gemini-3.1-flash-lite-preview             (20s)
//   Tier 4: gemini-3-flash-preview                    (25s)
//   Tier 5: gemini-3.1-pro-preview                    (30s)
//   Tier 6: fixed warm fallback text                  (instant)
//
// Worst case before fixed text: 105s. Realistic case: Tier 1 succeeds in
// 5-8s. Each tier uses error-feedback first, timeout as silent-hang safety
// net.
//
// Synthesis-readiness check: maybeFireSynthesis() only checks whether sleep
// has been logged today (across any entry_type). Score/emotions/activities/
// photo are guaranteed by the call-site invariant — the photo handler is
// the synthesis trigger, and reaching the photo handler means the user has
// already walked poll → emotions → activities Done → photo step in order.

import * as moodStore from './moodStore';
import * as episodeStore from './episodeStore';
import * as vectorStore from './vectorStore';
import { runCfAi } from '../lib/ai-gateway';
import { generateDeepResponse } from '../lib/ai/gemini';
import { getCheckinTiming } from '../lib/moodFlow';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';
import { log } from '../lib/logger';

// Cascade configuration. Tuples of [tier label, runner function, timeout ms].
const CASCADE = [
	['llama-3.3-70b', runLlamaTier, 15000],
	['gemma-3-12b',   runGemmaTier, 15000],
	['gemini-flash-lite', runGeminiTier.bind(null, 'gemini-3.1-flash-lite-preview'), 20000],
	['gemini-flash',  runGeminiTier.bind(null, 'gemini-3-flash-preview'), 25000],
	['gemini-pro',    runGeminiProTier, 30000],
];

const FIXED_FALLBACK_TEXT = 'Logged for tonight. We can talk through it whenever you are ready.';

/**
 * Run the end-of-flow synthesis cascade.
 *
 * Pulls today's combined mood data (across all entry_types), 30 days of
 * history, episodes, therapeutic notes, and semantic context. Walks the
 * 6-tier cascade. Returns the synthesis text, or FIXED_FALLBACK_TEXT if
 * every AI tier fails.
 *
 * Never throws. Caller is expected to send the returned text directly
 * to Telegram.
 *
 * @param {object} env             Worker env
 * @param {number} userId          Telegram user id
 * @param {number} startedAtMs     Flow started_at timestamp (for period label)
 * @param {string} systemPrompt    Persona instruction
 * @returns {Promise<{text: string, source: string, ms: number}>}
 */
export async function runSynthesisCascade(env, userId, startedAtMs, systemPrompt) {
	const t0 = Date.now();
	const today = moodStore.todayLondon();
	const period = getCheckinTiming(startedAtMs || Date.now());

	// Build the data block once. All tiers see the same prompt.
	const dataBlock = await buildSynthesisDataBlock(env, userId, today, period);
	const prompt = composeSynthesisPrompt(period, dataBlock);

	for (const [label, runner, timeoutMs] of CASCADE) {
		const tierStart = Date.now();
		const text = await runTier(runner, env, prompt, systemPrompt, timeoutMs, label);
		if (text) {
			const ms = Date.now() - t0;
			log.info('mood_synthesis_tier_ok', { userId, tier: label, tierMs: Date.now() - tierStart, totalMs: ms });
			return { text, source: label, ms };
		}
	}

	const ms = Date.now() - t0;
	log.warn('mood_synthesis_cascade_exhausted', { userId, totalMs: ms });
	return { text: FIXED_FALLBACK_TEXT, source: 'static', ms };
}

/**
 * Check whether today's mood check-in can complete and, if so, enqueue the
 * final synthesis task. Idempotent — uses a KV guard
 * (`mood_synthesis_fired_${chatId}_${date}`) to ensure the task fires at most
 * once per chat per day.
 *
 * Called from exactly two places:
 *   1. Photo upload handler / photo skip handler — by the time we get here,
 *      score / emotions / activities / photo are guaranteed answered this
 *      run (the user walked poll → emotions Done → activities Done → photo
 *      step in order). The only thing left to check is whether sleep is
 *      already in today's data; if not, the caller sends a prose sleep ask
 *      instead of firing synthesis.
 *   2. logMoodEntryTool.execute — fires after the user replies with sleep
 *      hours in prose. By this point sleep IS in today's data, so this
 *      call always returns ready=true (assuming the user did walk the flow).
 *
 * The check that gates firing is therefore minimal: do today's rows contain
 * any sleep_hours? If yes, fire. If no, return false so the caller can ask
 * for sleep.
 *
 * NOTE on activities + photo: we deliberately do NOT day-level check those
 * pieces. The previous implementation did, which meant /mood would skip
 * activities and photo if today already had them. That was wrong — the user
 * may have new activities or another photo to add. The keyboards already
 * support add/remove against today's existing items.
 *
 * @param {object} env       Worker env
 * @param {number} chatId    Telegram chat id
 * @param {number} userId    Telegram user id (often equals chatId)
 * @param {number|string} threadId  Telegram message_thread_id
 * @returns {Promise<boolean>}  True if synthesis was enqueued, false otherwise
 */
export async function maybeFireSynthesis(env, chatId, userId, threadId) {
	if (!chatId || !userId) return false;

	try {
		const today = moodStore.todayLondon();
		const guardKey = `mood_synthesis_fired_${chatId}_${today}`;

		// Guard: only fire once per day per chat.
		if (await env.CHAT_KV.get(guardKey)) {
			return false;
		}

		// Sleep is the only piece we check day-level. Score/emotions/activities/
		// photo are guaranteed by the call-site invariant (see docstring).
		const hasSleep = await moodStore.hasSleepLoggedToday(env, userId, today);
		if (!hasSleep) {
			log.info('mood_synthesis_waiting_for_sleep', { chatId, userId });
			return false;
		}

		if (!env.TASK_QUEUE) {
			log.warn('mood_synthesis_no_queue_binding', { chatId });
			return false;
		}

		const moodFlow = await import('../lib/moodFlow');
		const flow = await moodFlow.getFlow(env, chatId);

		// Set the guard BEFORE enqueueing to avoid double-fire if two advance
		// points race (e.g. activities-done and photo-skip happen in quick
		// succession). 26h TTL covers any retry window.
		await env.CHAT_KV.put(guardKey, '1', { expirationTtl: 26 * 3600 });

		await env.TASK_QUEUE.send({
			type: 'mood_synthesis_final',
			chatId,
			userId,
			threadId,
			startedAtMs: flow?.started_at || Date.now(),
		});

		log.info('mood_synthesis_enqueued', { chatId, userId });
		return true;
	} catch (e) {
		log.warn('mood_synthesis_fire_check_failed', { chatId, msg: e.message });
		return false;
	}
}

// ---- Data assembly ----

/**
 * Build the data block injected into the synthesis prompt. Pulls today's
 * combined data, 7-day history, recent episodes, therapeutic notes, and
 * semantic context.
 *
 * Returns a single string ready to drop into the prompt template.
 */
async function buildSynthesisDataBlock(env, userId, today, period) {
	// Today's combined data (across all entry_types)
	const dayEntries = await moodStore.getDayEntries(env, userId, today).catch(() => []);
	const todayCombined = combineDayEntries(dayEntries);

	// 7-day evening history
	const recent = await moodStore.getHistory(env, userId, 7, 'evening').catch(() => []);
	const recentBlock = recent.length
		? recent.slice(0, 7).map((row) => {
			let emotions = [];
			try {
				const parsed = JSON.parse(row.emotions || '[]');
				if (Array.isArray(parsed)) emotions = parsed;
			} catch { /* skip */ }
			const score = row.mood_score ?? '?';
			const emoStr = emotions.length ? `, ${emotions.join(', ')}` : '';
			return `- ${row.date}: ${score}/10${emoStr}`;
		}).join('\n')
		: 'No prior history on file.';

	// Episodes (filter by today's emotions if available)
	const episodeQueryEmotions = todayCombined.emotions;
	const episodes = episodeQueryEmotions.length
		? await episodeStore.getEpisodesByEmotion(env, userId, episodeQueryEmotions, 5).catch(() => [])
		: await episodeStore.getRecentEpisodes(env, userId, 5).catch(() => []);
	const episodeCtx = episodeStore.formatEpisodesForContext(episodes) || 'No past episodes to reference.';

	// Therapeutic notes
	const therapeuticNotes = await env.DB.prepare(
		`SELECT category, fact FROM memories
		 WHERE user_id = ? AND category IN ('pattern','trigger','schema','insight','homework','growth')
		 ORDER BY created_at DESC LIMIT 10`
	).bind(userId).all().then((r) => r.results || []).catch(() => []);
	const notesBlock = therapeuticNotes.length
		? therapeuticNotes.map((n) => `- [${n.category}] ${n.fact}`).join('\n')
		: 'No therapeutic notes on file yet.';

	// Semantic context based on today's emotions
	const semanticQuery = todayCombined.emotions.join(' ') || 'mood emotions feelings';
	const semanticCtx = await vectorStore.getSemanticContext(env, userId, semanticQuery).catch(() => '');

	return {
		period,
		todayScore: todayCombined.score,
		todayEmotions: todayCombined.emotions,
		todayActivities: todayCombined.activities,
		todaySleep: todayCombined.sleep,
		todayPhotoNote: todayCombined.photoNote,
		recentBlock,
		episodeCtx,
		notesBlock,
		semanticCtx,
	};
}

/**
 * Combine all of today's rows into a single picture. Fields:
 *   - score:    first non-null mood_score found
 *   - emotions: union across all rows, deduped
 *   - activities: union across all rows, deduped
 *   - sleep:    first non-null sleep_hours found
 *   - photoNote: human-friendly photo description, or null
 */
function combineDayEntries(dayEntries) {
	const out = {
		score: null,
		emotions: [],
		activities: [],
		sleep: null,
		photoNote: null,
	};
	const seenEmotions = new Set();
	const seenActivities = new Set();

	for (const row of (dayEntries || [])) {
		if (out.score === null && row.mood_score !== null && row.mood_score !== undefined) {
			out.score = row.mood_score;
		}
		if (row.emotions) {
			try {
				const parsed = JSON.parse(row.emotions);
				if (Array.isArray(parsed)) {
					for (const e of parsed) {
						if (typeof e === 'string' && !seenEmotions.has(e)) {
							seenEmotions.add(e);
							out.emotions.push(e);
						}
					}
				}
			} catch { /* skip */ }
		}
		if (row.activities) {
			try {
				const parsed = JSON.parse(row.activities);
				if (Array.isArray(parsed)) {
					for (const a of parsed) {
						if (typeof a === 'string' && !seenActivities.has(a)) {
							seenActivities.add(a);
							out.activities.push(a);
						}
					}
				}
			} catch { /* skip */ }
		}
		if (out.sleep === null && row.sleep_hours !== null && row.sleep_hours !== undefined) {
			out.sleep = row.sleep_hours;
		}
		if (!out.photoNote && row.photo_r2_key) {
			out.photoNote = `Photo attached (key: ${row.photo_r2_key.slice(0, 40)})`;
		}
	}

	return out;
}

/**
 * Compose the final synthesis prompt from the assembled data block.
 * Minimal instructions; the data block + role description does the work.
 */
function composeSynthesisPrompt(period, data) {
	const todayLines = [
		`- Mood score: ${data.todayScore !== null ? data.todayScore + '/10' : 'not recorded'}`,
		`- Emotions: ${data.todayEmotions.length ? data.todayEmotions.join(', ') : 'none selected'}`,
		`- Activities: ${data.todayActivities.length ? data.todayActivities.join(', ') : 'none logged'}`,
		`- Sleep: ${data.todaySleep !== null ? data.todaySleep + ' hours' : 'not recorded'}`,
	];
	if (data.todayPhotoNote) todayLines.push(`- Photo: ${data.todayPhotoNote}`);

	const sections = [
		`Roman just completed his mood check-in ${period}. Here's what he shared today:\n\n${todayLines.join('\n')}`,
		`The mood scale used here:\n${MOOD_POLL_OPTIONS.join('\n')}`,
		`His past 7 days:\n${data.recentBlock}`,
		`Recent episodes worth noting:\n${data.episodeCtx}`,
		`His patterns and known triggers from past sessions:\n${data.notesBlock}`,
	];

	if (data.semanticCtx) {
		sections.push(`Related themes from past conversations:\n${data.semanticCtx}`);
	}

	sections.push('Respond as a supportive and understanding friend who notices patterns and helps him think.');
	sections.push('If anything in the data suggests immediate safety concern, end your message with these helplines on a new line: Samaritans 116 123, SHOUT text 85258, NHS 111.');

	return sections.join('\n\n');
}

// ---- Cascade machinery ----

/**
 * Run one tier with mixed error-feedback + timeout. Returns response text
 * on success, null on any failure. Never throws.
 */
async function runTier(runner, env, prompt, systemPrompt, timeoutMs, label) {
	const t0 = Date.now();
	let didTimeout = false;
	try {
		const result = await Promise.race([
			runner(env, prompt, systemPrompt),
			new Promise((resolve) => setTimeout(() => {
				didTimeout = true;
				resolve(null);
			}, timeoutMs)),
		]);

		const elapsed = Date.now() - t0;
		if (didTimeout) {
			log.warn('mood_synthesis_tier_timeout', { tier: label, ms: elapsed, capMs: timeoutMs });
			return null;
		}

		const text = (typeof result === 'string') ? result : '';
		if (!text || !text.trim()) {
			log.warn('mood_synthesis_tier_empty', { tier: label, ms: elapsed });
			return null;
		}

		return text.trim();
	} catch (err) {
		const elapsed = Date.now() - t0;
		log.warn('mood_synthesis_tier_error', {
			tier: label,
			ms: elapsed,
			msg: (err?.message || '').slice(0, 200),
		});
		return null;
	}
}

async function runLlamaTier(env, prompt, systemPrompt) {
	if (!env.AI) return '';
	const messages = [];
	if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
	messages.push({ role: 'user', content: prompt });
	const result = await runCfAi(env.AI, '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
		{ messages, max_tokens: 1024 },
		{ headers: { 'x-session-affinity': 'xaridotis-mood-synth' } }
	);
	return extractWorkersAiText(result);
}

async function runGemmaTier(env, prompt, systemPrompt) {
	if (!env.AI) return '';
	const messages = [];
	if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
	messages.push({ role: 'user', content: prompt });
	const result = await runCfAi(env.AI, '@cf/google/gemma-3-12b-it',
		{ messages, max_tokens: 1024 },
		{ headers: { 'x-session-affinity': 'xaridotis-mood-synth' } }
	);
	return extractWorkersAiText(result);
}

async function runGeminiTier(modelId, env, prompt, systemPrompt) {
	if (!env.GEMINI_API_KEY) return '';
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	const response = await ai.models.generateContent({
		model: modelId,
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		config: {
			systemInstruction: systemPrompt,
			temperature: 1.0,
			maxOutputTokens: 1500,
		},
	});
	let text = '';
	if (typeof response?.text === 'string') text = response.text;
	else if (typeof response?.text === 'function') {
		try { text = response.text() || ''; } catch { /* skip */ }
	}
	if (!text) {
		text = response?.candidates?.[0]?.content?.parts
			?.filter((p) => p.text && !p.thought)
			?.map((p) => p.text)
			?.join('') || '';
	}
	return text;
}

async function runGeminiProTier(env, prompt, systemPrompt) {
	// Reuse the existing generateDeepResponse helper for Pro to keep the
	// thinking-budget and gateway settings consistent with the rest of
	// the codebase. medium thinking is enough for synthesis.
	const text = await generateDeepResponse(prompt, systemPrompt, env, {
		thinkingLevel: 'medium',
		maxOutputTokens: 1500,
	});
	return text || '';
}

function extractWorkersAiText(result) {
	if (!result) return '';
	if (typeof result === 'string') return result;
	if (typeof result.response === 'string') return result.response;
	const choice = result.choices?.[0]?.message?.content;
	if (typeof choice === 'string') return choice;
	return '';
}

export { FIXED_FALLBACK_TEXT };
