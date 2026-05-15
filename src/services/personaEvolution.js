// Persona evolution worker.
//
// Background job: looks at recent conversation patterns and updates the user's
// evolved_traits + communication_notes columns with observations. Runs as part
// of the daily 04:00 cron alongside style card consolidation.
//
// Data-driven cascade (2026-05-15, post-bench):
//   Tier 1: llama-3.3-70b-fp8-fast (CF) — 100% parse, 1.6s P50
//   Tier 2: qwen-coder-32b         (CF) — 100% parse, 1.85s P50
//
// SIGNAL SOURCES (in order of priority):
//   1. Recent feedback memories (RLHF reactions — strongest signal)
//   2. Recent insight memories (silent observations — medium signal)
//   3. Recent pattern memories (clinical observations — contextual)
//   4. Recent KV chat history (last 30 user turns from default thread)

import {
	runCascade,
	LLAMA_33_70B_MODEL,
	QWEN_CODER_32B_MODEL,
} from '../lib/ai/gemini';
import { getPersonaConfig, updatePersonaConfig } from './persona';

const EVOLUTION_TIERS = [
	{ kind: 'cf', model: LLAMA_33_70B_MODEL,   opts: { maxOutputTokens: 700 }, label: 'persona:llama-3.3-70b-fast' },
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL, opts: { maxOutputTokens: 700 }, label: 'persona:qwen-coder-32b' },
];

const EVOLUTION_PROMPT = `You are analysing recent interactions between a user and their AI companion to extract DURABLE observations.

Your job: produce TWO short outputs that should persist across conversations.

=== OUTPUT 1: COMMUNICATION_NOTES (how the user prefers to be spoken to) ===
Look for evidence of:
- Preferred response length (terse vs detailed)
- Tone preferences (dry humour, warmth, directness, formality level)
- What kind of questions land well vs flat
- Specific phrasings or framings to avoid

=== OUTPUT 2: EVOLVED_TRAITS (stable user-specific patterns) ===
Look for evidence of:
- Topics of recurring interest (hobbies, work focus, ongoing projects)
- Stable emotional patterns (e.g. "tends to deflect when overwhelmed", "opens up readily about work")
- Decision-making style (e.g. "prefers to be challenged", "wants options laid out")
- Reliable cues that distinguish this user

=== HARD RULES ===
- Only include observations supported by REPEATED evidence across multiple data points. One-off comments don't count.
- Skip transient mood states. Those go in mood_journal, not persona.
- Each line under 15 words. Total under 400 chars per output section.
- Third person about the user (e.g. "Roman tends to...").
- Do NOT invent. If evidence is thin, skip that section.
- If you have nothing high-confidence for EITHER section, return EXACTLY: NONE

=== OUTPUT FORMAT (strict) ===
COMMUNICATION_NOTES:
- bullet 1
- bullet 2

EVOLVED_TRAITS:
- bullet 1
- bullet 2

If one section has no high-confidence content, write "NONE" under that header. If BOTH sections are empty, return only the literal token NONE.`;

/**
 * Refresh evolved_traits and communication_notes for a user based on recent
 * data. Called from handleStyleCardConsolidation in index.js (04:00 cron).
 */
export async function evolvePersona(env, userId) {
	if (!env.AI || !env.DB) return;

	const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
	const signals = [];

	try {
		const { results: feedbacks } = await env.DB.prepare(
			"SELECT fact, importance_score, created_at FROM memories WHERE user_id = ? AND category = 'feedback' AND created_at > ? ORDER BY importance_score DESC, created_at DESC LIMIT 15"
		).bind(userId, sevenDaysAgo).all();
		for (const f of (feedbacks || [])) {
			signals.push(`[FEEDBACK imp=${f.importance_score}] ${f.fact}`);
		}

		const { results: insights } = await env.DB.prepare(
			"SELECT fact, created_at FROM memories WHERE user_id = ? AND category = 'insight' AND fact LIKE 'Implicit:%' AND created_at > ? ORDER BY created_at DESC LIMIT 10"
		).bind(userId, sevenDaysAgo).all();
		for (const i of (insights || [])) {
			signals.push(`[OBSERVATION] ${i.fact}`);
		}

		const { results: patterns } = await env.DB.prepare(
			"SELECT fact, created_at FROM memories WHERE user_id = ? AND category = 'pattern' AND created_at > ? ORDER BY created_at DESC LIMIT 5"
		).bind(userId, sevenDaysAgo).all();
		for (const p of (patterns || [])) {
			signals.push(`[PATTERN] ${p.fact}`);
		}
	} catch (err) {
		console.warn('persona evolution: signal fetch failed:', err.message);
		return;
	}

	try {
		const rawHistory = await env.CHAT_KV.get(`chat_${userId}_default`, { type: 'json' });
		if (Array.isArray(rawHistory)) {
			const userTurns = rawHistory
				.filter(t => t.role === 'user')
				.slice(-30)
				.map(t => (t.parts || []).map(p => p.text).filter(Boolean).join(' '))
				.filter(text => text && text.length > 5);
			if (userTurns.length >= 5) {
				signals.push(`[RECENT USER MESSAGES]\n${userTurns.slice(-15).map(t => `• ${t.slice(0, 200)}`).join('\n')}`);
			}
		}
	} catch (err) {
		console.warn('persona evolution: KV history fetch failed:', err.message);
	}

	if (signals.length < 5) {
		console.log(`🌱 Persona evolution skipped: only ${signals.length} signals (need 5+)`);
		return;
	}

	const current = await getPersonaConfig(env, userId);
	const existingTraits = current?.evolved_traits || '(none yet)';
	const existingNotes = current?.communication_notes || '(none yet)';

	const inputBlob = `Recent signals (${signals.length} total):\n\n${signals.join('\n\n')}\n\n=== CURRENT STATE ===\nExisting evolved_traits: ${existingTraits}\nExisting communication_notes: ${existingNotes}\n\nProduce updated COMMUNICATION_NOTES and EVOLVED_TRAITS based on the signals. Preserve existing observations that are still supported; refine or add based on new evidence.`;

	let text = null;
	try {
		text = await runCascade(env, inputBlob, EVOLUTION_PROMPT, EVOLUTION_TIERS);
	} catch (err) {
		console.warn('persona evolution: cascade failed:', err.message);
		return;
	}

	if (!text) return;
	text = text.trim();
	if (!text || text === 'NONE' || text.toUpperCase().startsWith('NONE')) {
		console.log('🌱 Persona evolution: no high-confidence updates');
		return;
	}

	const notesMatch = text.match(/COMMUNICATION_NOTES:\s*([\s\S]*?)(?:EVOLVED_TRAITS:|$)/i);
	const traitsMatch = text.match(/EVOLVED_TRAITS:\s*([\s\S]*?)$/i);

	const cleanSection = (section) => {
		if (!section) return null;
		const trimmed = section.trim();
		if (!trimmed || /^NONE/i.test(trimmed)) return null;
		if (!trimmed.includes('- ')) return null;
		if (trimmed.length > 600) return null;
		return trimmed;
	};

	const newNotes = cleanSection(notesMatch?.[1]);
	const newTraits = cleanSection(traitsMatch?.[1]);

	if (!newNotes && !newTraits) {
		console.log('🌱 Persona evolution: output failed shape check, skipping');
		return;
	}

	try {
		const patch = {};
		if (newNotes) patch.communication_notes = newNotes;
		if (newTraits) patch.evolved_traits = newTraits;
		await updatePersonaConfig(env, userId, patch);
		console.log(`🌱 Persona evolved for user ${userId} — notes: ${newNotes ? 'updated' : 'kept'}, traits: ${newTraits ? 'updated' : 'kept'}`);
	} catch (err) {
		console.warn('persona evolution: DB write failed:', err.message);
	}
}
