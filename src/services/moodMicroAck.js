// Mood check-in micro-acknowledgements.
//
// Two short AI calls embedded in the deterministic mood flow:
//   1. After the user picks a score on the poll  -> runScoreAck()
//   2. After the user finishes selecting emotions -> runEmotionsAck()
//
// Data-driven cascades (2026-05-15, post-bench):
//   mood_score_ack:    qwen-coder-32b → llama-3.3-70b-fp8-fast
//   mood_emotions_ack: llama-4-scout-17b → llama-3.3-70b-fp8-fast
//
// Both cascades pull from CF Workers AI — the bench showed CF models dominate
// persona-heavy tasks at lower latency than Gemini equivalents. Tier 1 is
// fastest under load; Tier 2 (llama-3.3-70b-fp8-fast) is the universal
// performer (100% parse across all 10 benched tasks).
//
// Prompts are intentionally minimal: situation + role description, nothing
// about HOW to respond. Persona system prompt handles tone.

import * as moodStore from './moodStore';
import {
	runCascade,
	QWEN_CODER_32B_MODEL,
	LLAMA_4_SCOUT_MODEL,
	LLAMA_33_70B_MODEL,
} from '../lib/ai/gemini';
import { getCheckinTiming } from '../lib/moodFlow';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';
import { log } from '../lib/logger';

// Score ack: qwen-coder Tier 1 (921ms P50, 100% bench), llama-70b Tier 2.
const SCORE_ACK_TIERS = [
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL, opts: { maxOutputTokens: 1500 }, label: 'score-ack:qwen-coder-32b' },
	{ kind: 'cf', model: LLAMA_33_70B_MODEL,   opts: { maxOutputTokens: 1500 }, label: 'score-ack:llama-3.3-70b-fast' },
];

// Emotions ack: scout Tier 1 (1.25s P50, 100% bench), llama-70b Tier 2.
const EMOTIONS_ACK_TIERS = [
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL,  opts: { maxOutputTokens: 1500 }, label: 'emo-ack:llama-4-scout' },
	{ kind: 'cf', model: LLAMA_33_70B_MODEL,   opts: { maxOutputTokens: 1500 }, label: 'emo-ack:llama-3.3-70b-fast' },
];

const STATIC_SCORE_ACK = 'Got it. Tap below to share what you are feeling.';
const STATIC_EMOTIONS_ACK = 'Got it.';

// Negative emotions list mirrors src/bot/handlers.js mood_emo_done handler.
const NEGATIVE_EMOTIONS = [
	'devastated', 'empty', 'frustrated', 'scared', 'angry', 'depressed',
	'sad', 'anxious', 'annoyed', 'insecure', 'lonely', 'confused',
	'tired', 'bored', 'nervous', 'disappointed', 'lost',
];

/**
 * Run the score-tap micro-acknowledgement cascade.
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
	const text = await runCascade(env, prompt, systemPrompt, SCORE_ACK_TIERS);
	const finalText = (text || '').trim() || STATIC_SCORE_ACK;
	log.info('mood_score_ack_done', {
		userId,
		score,
		ms: Date.now() - t0,
		len: finalText.length,
		fellThrough: !text,
	});
	return finalText;
}

/**
 * Run the emotions-Done micro-acknowledgement cascade.
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
	const text = await runCascade(env, prompt, systemPrompt, EMOTIONS_ACK_TIERS);
	const finalText = (text || '').trim() || STATIC_EMOTIONS_ACK;
	log.info('mood_emotions_ack_done', {
		userId,
		emotionCount: (emotions || []).length,
		ms: Date.now() - t0,
		len: finalText.length,
		fellThrough: !text,
	});
	return finalText;
}

// ---- Context builders ----

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
