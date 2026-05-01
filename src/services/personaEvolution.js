// Persona evolution worker.
//
// Background job: looks at recent conversation patterns and updates the user's
// evolved_traits column with observations. Runs as part of the existing
// memory consolidation cron (so we don't add another scheduled tick).
//
// Uses cheap Cloudflare AI (Llama 3.1 8B) for extraction — this is a
// background quality job, not user-facing, so latency and cost matter more
// than peak quality. ~13 included neurons per call.

import { runCfAi } from '../lib/ai-gateway';
import { getPersonaConfig, updatePersonaConfig } from './persona';

const OBSERVATION_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const EVOLUTION_PROMPT = `You are a memory consolidator analysing a few days of chat history between a user and an AI companion called Xaridotis.

Your task: extract DURABLE personality observations about the USER (not Xaridotis) — things that should persist across conversations.

Look for evidence of:
- Communication preferences (e.g. "prefers brief replies", "responds well to dry humour")
- Topics of recurring interest (hobbies, work, pet projects)
- Stable emotional patterns (e.g. "tends to deflect when overwhelmed", "opens up about work freely")
- Things that genuinely help vs things that don't

Rules:
- Only include observations supported by REPEATED evidence across multiple turns. One-off comments don't count.
- Skip transient mood states ("was sad on Tuesday"). Those go in mood_journal, not persona.
- Keep each note SHORT (under 15 words). Total output under 400 chars.
- Write in third person about the user (e.g. "Roman tends to...", not "you tend to...").
- If you have nothing high-confidence to add, return EXACTLY the literal token: NONE

Output format: a flat list of bullet points, each starting with "- ", no preamble, no headers, no closing remarks.`;

/**
 * Refresh evolved_traits and communication_notes for a user based on recent
 * conversation patterns. Called from handleMemoryConsolidation in index.js.
 *
 * Idempotent: if there's nothing useful to add, leaves existing traits unchanged.
 */
export async function evolvePersona(env, userId) {
	if (!env.AI || !env.DB) return;

	// Pull last 7 days of chat summaries — enough to see patterns, not so much
	// that we drown in old context.
	let summaries = [];
	try {
		const rows = await env.DB.prepare(
			"SELECT summary FROM chat_summaries WHERE user_id = ? AND created_at > datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 30"
		).bind(userId).all();
		summaries = (rows.results || []).map(r => r.summary).filter(Boolean);
	} catch (err) {
		console.warn('persona evolution: chat_summaries fetch failed:', err.message);
		return;
	}

	if (summaries.length < 5) {
		// Not enough signal yet — wait for more conversation data
		return;
	}

	const current = await getPersonaConfig(env, userId);
	const existingTraits = current.evolved_traits || '(none yet)';
	const existingNotes = current.communication_notes || '(none yet)';

	const inputBlob = `Recent conversation summaries:\n\n${summaries.slice(0, 20).join('\n\n')}\n\nExisting evolved_traits: ${existingTraits}\nExisting communication_notes: ${existingNotes}`;

	let result;
	try {
		result = await runCfAi(env.AI, OBSERVATION_MODEL, {
			messages: [
				{ role: 'system', content: EVOLUTION_PROMPT },
				{ role: 'user', content: inputBlob },
			],
			temperature: 0.6,
			max_tokens: 500,
		});
	} catch (err) {
		console.warn('persona evolution: CF AI call failed:', err.message);
		return;
	}

	const text = (result?.choices?.[0]?.message?.content || result?.response || '').trim();
	if (!text || text === 'NONE' || text.toUpperCase().startsWith('NONE')) return;

	// Sanity-check the output: must look like bullet points, must be under 600 chars.
	if (!text.includes('- ') || text.length > 600) {
		console.warn('persona evolution: output failed shape check, skipping');
		return;
	}

	try {
		await updatePersonaConfig(env, userId, { evolved_traits: text });
		console.log(`🌱 Persona evolved for user ${userId}: ${text.slice(0, 80)}...`);
	} catch (err) {
		console.warn('persona evolution: DB write failed:', err.message);
	}
}
