// Mood check-in micro-acknowledgements.
//
// Two short AI calls embedded in the deterministic mood flow:
//   1. After the user picks a score on the poll  -> runScoreAck()
//   2. After the user finishes selecting emotions -> runEmotionsAck()
//
// Both calls run a 2-tier cascade for speed. Mid-flow latency budget is tight:
// a friend's "ok, that's a lot" should land in 2-3 seconds, not 8-15. We
// deliberately do NOT fall through to Gemini Pro here — if both tiers fail
// we send static text. The end-of-flow synthesis (moodSynthesis.js) carries
// the heavy clinical observation and has a longer cascade.
//
// Architecture B+ cascade (2026-05-14):
//   Tier 1: gemini-2.5-flash-lite, thinkingBudget=-1  (15s budget)
//   Tier 2: @cf/google/gemma-4-26b-a4b-it             (15s budget)
//   Tier 3: static fallback text                       (instant)
//
// Each tier uses error-feedback first (clean errors fall through immediately),
// timeout second (silent-hang safety net). Worst case before static: ~30s.
// Realistic case: 1-3s on Tier 1.
//
// Prompts are intentionally minimal: situation + role description, nothing
// about HOW to respond. Persona system prompt handles tone.

import * as moodStore from './moodStore';
import { runCfAi } from '../lib/ai-gateway';
import { geminiBackgroundGenerate } from '../lib/ai/gemini';
import { getCheckinTiming } from '../lib/moodFlow';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';
import { log } from '../lib/logger';

const TIER1_MODEL = 'gemini-2.5-flash-lite';            // Architecture B+ primary (73.0/108 dynamic)
const TIER2_MODEL = '@cf/google/gemma-4-26b-a4b-it';    // Vendor-diversified fallback via CF
const TIER1_TIMEOUT_MS = 15000;
const TIER2_TIMEOUT_MS = 15000;

const STATIC_SCORE_ACK = 'Got it. Tap below to share what you are feeling.';
const STATIC_EMOTIONS_ACK = 'Got it.';

// Negative emotions list mirrors src/bot/handlers.js mood_emo_done handler.
// Used to split selected emotions for the prompt.
const NEGATIVE_EMOTIONS = [
	'devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed',
	'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused',
	'tired', 'bored', 'nervous', 'disappointed', 'lost',
];

/**
 * Run the score-tap micro-acknowledgement cascade.
 *
 * Called from handleMoodPollAnswer immediately after upserting the mood
 * score and advancing the flow stage. Returns the model's response text,
 * or static fallback if both Workers AI tiers fail.
 *
 * @param {object} env       Worker env
 * @param {number} userId    Telegram user id
 * @param {number} score     Mood score 0-10
 * @param {object} flow      Flow state from moodFlow.getFlow (or null)
 * @param {string} systemPrompt  Persona instruction (tone/severity handler)
 * @returns {Promise<string>}    Acknowledgement text (never empty)
 */
export async function runScoreAck(env, userId, score, flow, systemPrompt) {
	const startedAtMs = flow?.started_at || Date.now();
	const period = getCheckinTiming(startedAtMs);
	const recentScoresList = await buildRecentScoresList(env, userId);
	const therapeuticNotes = await buildTherapeuticNotesBlock(env, userId);

	const prompt = `Roman just logged his mood ${period} as ${score} out of 10.

The mood scale used here:
${MOOD_POLL_OPTIONS.join('\n')}

His recent scores over the last 5 days were:
${recentScoresList}

His patterns and known triggers from past sessions:
${therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices.`;

	const t0 = Date.now();
	const result = await runCascade(env, prompt, systemPrompt, 'score_ack');
	log.info('mood_score_ack_done', {
		userId,
		score,
		source: result.source,
		ms: Date.now() - t0,
		len: result.text.length,
	});

	return result.text || STATIC_SCORE_ACK;
}

/**
 * Run the emotions-Done micro-acknowledgement cascade.
 *
 * Called from the mood_emo_done callback after upserting emotions and
 * advancing the flow stage. Returns the model's response text, or static
 * fallback if both Workers AI tiers fail.
 *
 * @param {object} env             Worker env
 * @param {number} userId          Telegram user id
 * @param {string[]} emotions      Selected emotion keys
 * @param {object} flow            Flow state from moodFlow.getFlow
 * @param {string} systemPrompt    Persona instruction
 * @returns {Promise<string>}      Acknowledgement text (never empty)
 */
export async function runEmotionsAck(env, userId, emotions, flow, systemPrompt) {
	const startedAtMs = flow?.started_at || Date.now();
	const period = getCheckinTiming(startedAtMs);
	const recentEmotionsList = await buildRecentEmotionsList(env, userId);
	const therapeuticNotes = await buildTherapeuticNotesBlock(env, userId);
	const emotionList = (emotions || []).join(', ') || 'none selected';

	const prompt = `Roman just logged these emotions ${period}: ${emotionList}.

His emotions over the last 5 days were:
${recentEmotionsList}

His patterns and known schemas from past sessions:
${therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices patterns.`;

	const t0 = Date.now();
	const result = await runCascade(env, prompt, systemPrompt, 'emotions_ack');
	log.info('mood_emotions_ack_done', {
		userId,
		emotionCount: (emotions || []).length,
		source: result.source,
		ms: Date.now() - t0,
		len: result.text.length,
	});

	return result.text || STATIC_EMOTIONS_ACK;
}

// ---- Cascade machinery ----

/**
 * Run the 2-tier cascade. Returns { text, source } where source identifies
 * the winning tier. Empty text falls through to the next tier (no minimum-
 * length guard, but we treat whitespace-only as empty).
 */
async function runCascade(env, prompt, systemPrompt, kind) {
	// Tier 1: Gemini 2.5 FL dynamic
	const tier1 = await tryGeminiTier(env, TIER1_MODEL, prompt, systemPrompt, TIER1_TIMEOUT_MS, kind);
	if (tier1) return { text: tier1, source: 'gemini-2.5-flash-lite-dyn' };

	// Tier 2: Gemma 4 via CF (vendor diversification)
	if (env.AI) {
		const tier2 = await tryCfTier(env, TIER2_MODEL, systemPrompt, prompt, TIER2_TIMEOUT_MS, kind, 'gemma-4');
		if (tier2) return { text: tier2, source: 'gemma-4' };
	}

	// Both tiers exhausted. Return empty so caller substitutes static.
	log.warn('mood_micro_ack_cascade_exhausted', { kind });
	return { text: '', source: 'static' };
}

/**
 * Run the Gemini tier with wall-clock timeout. Returns response text on
 * success, null on any failure (timeout, network, overload, empty response).
 * Never throws.
 */
async function tryGeminiTier(env, model, prompt, systemPrompt, timeoutMs, kind) {
	if (!env.GEMINI_API_KEY) return null;
	const t0 = Date.now();
	let didTimeout = false;
	try {
		const result = await Promise.race([
			geminiBackgroundGenerate(env, model, prompt, systemPrompt, { thinkingBudget: -1, maxOutputTokens: 1000 }),
			new Promise((resolve) => setTimeout(() => {
				didTimeout = true;
				resolve(null);
			}, timeoutMs)),
		]);
		const elapsed = Date.now() - t0;
		if (didTimeout) {
			log.warn('mood_micro_ack_tier_timeout', { kind, tier: 'gemini-2.5-flash-lite', ms: elapsed, capMs: timeoutMs });
			return null;
		}
		if (!result || !result.trim()) {
			log.warn('mood_micro_ack_tier_empty', { kind, tier: 'gemini-2.5-flash-lite', ms: elapsed });
			return null;
		}
		log.info('mood_micro_ack_tier_ok', { kind, tier: 'gemini-2.5-flash-lite', ms: elapsed });
		return result.trim();
	} catch (err) {
		const elapsed = Date.now() - t0;
		log.warn('mood_micro_ack_tier_error', {
			kind,
			tier: 'gemini-2.5-flash-lite',
			ms: elapsed,
			msg: (err?.message || '').slice(0, 200),
		});
		return null;
	}
}

/**
 * Run a Cloudflare-AI tier with mixed error-feedback + timeout. Returns the
 * response text on success, null on any failure. Never throws.
 */
async function tryCfTier(env, model, systemPrompt, prompt, timeoutMs, kind, tierLabel) {
	const messages = [];
	if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
	messages.push({ role: 'user', content: prompt });

	const t0 = Date.now();
	let didTimeout = false;
	try {
		const result = await Promise.race([
			runCfAi(env.AI, model, { messages, max_tokens: 256 }, {
				headers: { 'x-session-affinity': 'xaridotis-mood-ack' },
			}),
			new Promise((resolve) => setTimeout(() => {
				didTimeout = true;
				resolve(null);
			}, timeoutMs)),
		]);

		const elapsed = Date.now() - t0;
		if (didTimeout) {
			log.warn('mood_micro_ack_tier_timeout', { kind, tier: tierLabel, ms: elapsed, capMs: timeoutMs });
			return null;
		}

		const text = extractText(result);
		if (!text || !text.trim()) {
			log.warn('mood_micro_ack_tier_empty', { kind, tier: tierLabel, ms: elapsed });
			return null;
		}

		log.info('mood_micro_ack_tier_ok', { kind, tier: tierLabel, ms: elapsed });
		return text.trim();
	} catch (err) {
		const elapsed = Date.now() - t0;
		log.warn('mood_micro_ack_tier_error', {
			kind,
			tier: tierLabel,
			ms: elapsed,
			msg: (err?.message || '').slice(0, 200),
		});
		return null;
	}
}

function extractText(result) {
	if (!result) return '';
	if (typeof result === 'string') return result;
	// Workers AI shape: { response: string } or { choices: [{ message: { content } }] }
	if (typeof result.response === 'string') return result.response;
	const choice = result.choices?.[0]?.message?.content;
	if (typeof choice === 'string') return choice;
	return '';
}

// ---- Context builders ----

/**
 * Build a 5-line summary of recent scores. Pulls the last 5 evening entries
 * from D1. Returns "No recent scores on file." when empty.
 */
async function buildRecentScoresList(env, userId) {
	try {
		const history = await moodStore.getHistory(env, userId, 14, 'evening');
		const scored = history
			.map((row) => ({
				date: row.date,
				score: row.mood_score,
			}))
			.filter((r) => r.score !== null && r.score !== undefined)
			.slice(0, 5);

		if (!scored.length) return 'No recent scores on file.';
		return scored.map((r) => `- ${r.date}: ${r.score}/10`).join('\n');
	} catch (e) {
		log.warn('mood_micro_ack_recent_scores_failed', { msg: e.message });
		return 'No recent scores on file.';
	}
}

/**
 * Build a 5-line summary of recent emotions. Pulls the last 5 evening
 * entries with non-empty emotions arrays.
 */
async function buildRecentEmotionsList(env, userId) {
	try {
		const history = await moodStore.getHistory(env, userId, 14, 'evening');
		const withEmotions = history
			.map((row) => {
				let emotions = [];
				if (row.emotions) {
					try {
						const parsed = JSON.parse(row.emotions);
						if (Array.isArray(parsed)) emotions = parsed;
					} catch { /* skip */ }
				}
				return { date: row.date, emotions };
			})
			.filter((r) => r.emotions.length > 0)
			.slice(0, 5);

		if (!withEmotions.length) return 'No recent emotions on file.';
		return withEmotions.map((r) => `- ${r.date}: ${r.emotions.join(', ')}`).join('\n');
	} catch (e) {
		log.warn('mood_micro_ack_recent_emotions_failed', { msg: e.message });
		return 'No recent emotions on file.';
	}
}

/**
 * Build the therapeutic notes block. Pulls recent pattern/trigger/schema/
 * insight memories. Returns "No therapeutic notes on file yet." when empty.
 */
async function buildTherapeuticNotesBlock(env, userId) {
	try {
		const { results } = await env.DB.prepare(
			`SELECT category, fact FROM memories
			 WHERE user_id = ? AND category IN ('pattern','trigger','schema','insight','homework','growth')
			 ORDER BY created_at DESC LIMIT 8`
		).bind(userId).all();

		const rows = results || [];
		if (!rows.length) return 'No therapeutic notes on file yet.';
		return rows.map((n) => `- [${n.category}] ${n.fact}`).join('\n');
	} catch (e) {
		log.warn('mood_micro_ack_notes_failed', { msg: e.message });
		return 'No therapeutic notes on file yet.';
	}
}

export { NEGATIVE_EMOTIONS };
