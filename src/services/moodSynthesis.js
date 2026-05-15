// End-of-flow mood check-in synthesis.
//
// Fires once at the END of a mood check-in, after all data is collected
// (score, emotions, activities, sleep, photo-or-skipped). This is the ONE
// AI call per check-in that produces the therapeutic observation that
// connects today's data to past patterns.
//
// Data-driven cascade (2026-05-15, post-bench):
//   Tier 1: llama-3.3-70b-fp8-fast (CF) — 100% parse, 3.9s P50.
//           Only model with 100% on the today-only emotions anchor.
//   Tier 2: llama-4-scout-17b      (CF) — 93% parse, 2.1s P50.
//           Insurance fallback per Roma's call: prefer occasional
//           hallucination risk over silent failure on Tier 1 outage.
//
// Synthesis-readiness check: maybeFireSynthesis() only checks whether sleep
// has been logged today. Score/emotions/activities/photo are guaranteed by
// the call-site invariant.

import * as moodStore from './moodStore';
import * as episodeStore from './episodeStore';
import * as vectorStore from './vectorStore';
import {
	runCascade,
	LLAMA_33_70B_MODEL,
	LLAMA_4_SCOUT_MODEL,
} from '../lib/ai/gemini';
import { getCheckinTiming } from '../lib/moodFlow';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';
import { log } from '../lib/logger';

// Cascade for end-of-flow synthesis. Generous token budget (2000) so the
// synthesis can connect patterns properly.
const SYNTHESIS_TIERS = [
	{ kind: 'cf', model: LLAMA_33_70B_MODEL,  opts: { maxOutputTokens: 2000 }, label: 'synth:llama-3.3-70b-fast' },
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL, opts: { maxOutputTokens: 2000 }, label: 'synth:llama-4-scout' },
];

const FIXED_FALLBACK_TEXT = 'Logged for tonight. We can talk through it whenever you are ready.';

/**
 * Run the end-of-flow synthesis cascade.
 *
 * @returns {Promise<{text: string, source: string, ms: number}>}
 */
export async function runSynthesisCascade(env, userId, startedAtMs, systemPrompt) {
	const t0 = Date.now();
	const today = moodStore.todayLondon();
	const period = getCheckinTiming(startedAtMs || Date.now());

	// Build the data block once. All tiers see the same prompt.
	const dataBlock = await buildSynthesisDataBlock(env, userId, today, period);
	const prompt = composeSynthesisPrompt(period, dataBlock);

	const text = await runCascade(env, prompt, systemPrompt, SYNTHESIS_TIERS);
	const ms = Date.now() - t0;
	if (text) {
		log.info('mood_synthesis_done', { userId, totalMs: ms, len: text.length });
		return { text, source: 'cascade', ms };
	}

	log.warn('mood_synthesis_cascade_exhausted', { userId, totalMs: ms });
	return { text: FIXED_FALLBACK_TEXT, source: 'static', ms };
}

/**
 * Check whether today's mood check-in can complete and, if so, enqueue the
 * final synthesis task. Idempotent via KV guard.
 */
export async function maybeFireSynthesis(env, chatId, userId, threadId) {
	if (!chatId || !userId) return false;

	try {
		const today = moodStore.todayLondon();
		const guardKey = `mood_synthesis_fired_${chatId}_${today}`;

		if (await env.CHAT_KV.get(guardKey)) {
			return false;
		}

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

async function buildSynthesisDataBlock(env, userId, today, period) {
	const dayEntries = await moodStore.getDayEntries(env, userId, today).catch(() => []);
	const todayCombined = combineDayEntries(dayEntries);

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

	const episodeQueryEmotions = todayCombined.emotions;
	const episodes = episodeQueryEmotions.length
		? await episodeStore.getEpisodesByEmotion(env, userId, episodeQueryEmotions, 5).catch(() => [])
		: await episodeStore.getRecentEpisodes(env, userId, 5).catch(() => []);
	const episodeCtx = episodeStore.formatEpisodesForContext(episodes) || 'No past episodes to reference.';

	const therapeuticNotes = await env.DB.prepare(
		`SELECT category, fact FROM memories
		 WHERE user_id = ? AND category IN ('pattern','trigger','schema','insight','homework','growth')
		 ORDER BY created_at DESC LIMIT 10`
	).bind(userId).all().then((r) => r.results || []).catch(() => []);
	const notesBlock = therapeuticNotes.length
		? therapeuticNotes.map((n) => `- [${n.category}] ${n.fact}`).join('\n')
		: 'No therapeutic notes on file yet.';

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

	sections.push(
		'Respond as a supportive and understanding friend who notices patterns and helps him think. ' +
		'CRITICAL: only reference emotions Roman recorded TODAY. The 7-day history is for trend context, ' +
		'not for naming today\'s state — do not invent or mix in emotions from other days.'
	);
	sections.push('If anything in the data suggests immediate safety concern, end your message with these helplines on a new line: Samaritans 116 123, SHOUT text 85258, NHS 111.');

	return sections.join('\n\n');
}

export { FIXED_FALLBACK_TEXT };
