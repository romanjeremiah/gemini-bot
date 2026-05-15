// Pre-response curator.
//
// Before the main model generates a response, a cheap fast model reads the
// incoming message + retrieved memCtx + recent history and produces a curated
// summary that gets PREPENDED to the prompt. The main model then receives a
// tighter, decision-ready context instead of raw memory dumps.
//
// Data-driven cascade (2026-05-15, post-bench):
//   Tier 1: llama-3.3-70b-fp8-fast (CF)        — 100% JSON parse, 2.3s P50.
//           Replaces deprecated Hermes 2 Pro — same latency profile,
//           native JSON shape compliance without responseMimeType.
//   Tier 2: gemini-2.5-flash-lite (thinkingBudget=512) — 100% parse, 3.5s P50.
//           Cross-provider fallback with strict JSON via responseMimeType.
//
// What the curator outputs:
//   - relevant_memory_ids: which memCtx memories actually relate to this turn
//   - register_hint: 'casual' | 'warm' | 'technical' | 'urgent'
//   - flags: array of structured signals
//   - reasoning: 1-2 sentence summary the main model can read to ground itself
//
// When NOT to curate (early-exit):
//   - userText < 30 chars (no signal worth analysing)
//   - active health check-in (register already locked)
//   - no memCtx and no semanticCtx (nothing to curate)

import {
	runCascade,
	FLASH_LITE_25_MODEL,
	LLAMA_33_70B_MODEL,
} from '../lib/ai/gemini';
import { log } from '../lib/logger';

const CURATOR_TIERS = [
	{ kind: 'cf',     model: LLAMA_33_70B_MODEL, opts: { maxOutputTokens: 800 },                                                       label: 'curator:llama-3.3-70b-fast' },
	{ kind: 'gemini', model: FLASH_LITE_25_MODEL, opts: { maxOutputTokens: 800, responseMimeType: 'application/json', thinkingBudget: 512 }, label: 'curator:2.5-fl-b512' },
];

const CURATOR_PROMPT = `You are a pre-response curator for an AI companion called Xaridotis.

A user just sent a message. You have access to retrieved memories and recent chat history. Your job is NOT to respond to the user. Your job is to produce a STRUCTURED ANALYSIS that the main model will use to ground its reply.

Return ONLY valid JSON, no markdown:
{
  "register": "casual" | "warm" | "technical" | "urgent",
  "flags": [array of strings, see below],
  "relevant_memory_ids": [array of memory ids that genuinely relate to this turn],
  "reasoning": "1-2 sentence summary of what's happening and what the main model should attend to"
}

REGISTER GUIDE:
- casual: small talk, status updates, light chat
- warm: emotional content, vulnerability, distress, reflection
- technical: code, architecture, debugging, research, structured planning
- urgent: crisis signals, safety concerns, acute distress

FLAGS (include any that apply, omit empty):
- crisis: explicit self-harm or suicide mentions
- med_question: about medication, doses, timing
- positive_state: user reports feeling good, breakthrough, win
- negative_state: user reports feeling low, stuck, frustrated
- recall_request: user is asking the bot to remember or look up something
- project_continuity: user references an ongoing project/conversation
- correction: user is correcting a prior bot mistake
- topic_change: clear pivot from previous conversation
- short_ack: simple acknowledgement, no substantive content

HARD RULES:
- Only include memory_ids that ACTUALLY relate to the current message. Be strict. Empty array is fine.
- Reasoning under 200 chars. No advice for the main model. Just observation.
- Do NOT invent flags or memories. If unsure, omit.
- If the message is too short to analyse meaningfully, return register: "casual", flags: ["short_ack"], relevant_memory_ids: [], reasoning: "Brief acknowledgement, no substantive content."
- Output ONLY the JSON object. No preamble, no explanation, no markdown fences.`;

/**
 * Build the curator user-side input from our context bundle.
 */
function buildCuratorInput({ userText, memories, recentHistory, semanticCtxPreview }) {
	const memorySection = memories.length
		? memories.slice(0, 20).map(m => `[id=${m.id}|${m.category}] ${(m.fact || '').slice(0, 200)}`).join('\n')
		: '(no memories)';

	const historySection = recentHistory.length
		? recentHistory.slice(-4).map(t => {
			const role = t.role === 'model' ? 'BOT' : 'USER';
			const text = (t.parts || []).map(p => p.text).filter(Boolean).join(' ').slice(0, 200);
			return `${role}: ${text}`;
		}).join('\n')
		: '(no recent history)';

	return `INCOMING USER MESSAGE:\n${userText.slice(0, 800)}\n\nRETRIEVED MEMORIES:\n${memorySection}\n\nRECENT HISTORY:\n${historySection}\n\n${semanticCtxPreview ? `SEMANTIC CONTEXT:\n${semanticCtxPreview.slice(0, 400)}\n\n` : ''}Produce the JSON analysis.`;
}

/**
 * Parse + validate raw curator output. Three-tier parser:
 *   1. Direct JSON.parse
 *   2. Greedy regex extraction (strips preamble/postamble)
 *   3. Brace-balance truncation recovery (rebuilds cut-off JSON)
 */
function parseCuratorOutput(rawText) {
	if (!rawText) return null;

	const cleaned = String(rawText).replace(/```json|```/g, '').trim();

	let parsed = null;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				parsed = JSON.parse(jsonMatch[0]);
			} catch { /* fall through to truncation recovery */ }
		}

		if (!parsed) {
			const firstBrace = cleaned.indexOf('{');
			if (firstBrace !== -1) {
				const slice = cleaned.slice(firstBrace);
				let depth = 0;
				let inString = false;
				let escape = false;
				let recovered = '';
				for (const ch of slice) {
					recovered += ch;
					if (escape) { escape = false; continue; }
					if (ch === '\\' && inString) { escape = true; continue; }
					if (ch === '"') inString = !inString;
					if (inString) continue;
					if (ch === '{') depth++;
					else if (ch === '}') depth--;
				}
				if (inString) recovered += '"';
				recovered = recovered.replace(/,\s*$/, '');
				while (depth > 0) { recovered += '}'; depth--; }
				try {
					parsed = JSON.parse(recovered);
					log.info('curator_truncation_recovered', { rawLen: rawText.length, recoveredLen: recovered.length });
				} catch (err) {
					log.warn('curator_recovery_failed', { msg: err.message, rawPreview: rawText.slice(0, 150) });
				}
			}
		}
	}

	if (!parsed) {
		log.warn('curator_unparseable', { rawPreview: rawText.slice(0, 150) });
		return null;
	}

	const register = ['casual', 'warm', 'technical', 'urgent'].includes(parsed.register) ? parsed.register : 'casual';
	const flags = Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string').slice(0, 8) : [];
	const relevantIds = Array.isArray(parsed.relevant_memory_ids)
		? parsed.relevant_memory_ids.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 12)
		: [];
	const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : '';

	return { register, flags, relevant_memory_ids: relevantIds, reasoning };
}

/**
 * Curate context for an incoming message.
 */
export async function curateContext(env, { userText, memories = [], recentHistory = [], semanticCtxPreview = '' }) {
	if (!userText || userText.length < 30) {
		return null;
	}
	if (!memories.length && !semanticCtxPreview) {
		return null;
	}

	const t0 = Date.now();
	const input = buildCuratorInput({ userText, memories, recentHistory, semanticCtxPreview });

	// Walk the full 5-tier cascade. runCascade returns the first non-empty text;
	// if a tier produces unparseable JSON, the parser will fail and we manually
	// loop to the next tier by re-running the cascade with a sliced tier list.
	// To keep the code simple we walk tiers one-by-one here.
	let rawText = null;
	let provider = null;
	let result = null;

	for (let i = 0; i < CURATOR_TIERS.length; i++) {
		const tier = CURATOR_TIERS[i];
		rawText = await runCascade(env, input, CURATOR_PROMPT, [tier]);
		if (!rawText) continue;
		result = parseCuratorOutput(rawText);
		if (result) {
			provider = tier.label;
			break;
		}
		log.info('curator_tier_unparseable', { tier: tier.label, rawPreview: rawText.slice(0, 120) });
	}

	if (!result) {
		log.warn('curator_all_providers_failed');
		return null;
	}

	const elapsed = Date.now() - t0;
	log.info('curator_complete', {
		elapsed_ms: elapsed,
		curator_provider: provider,
		register: result.register,
		flagCount: result.flags.length,
		relevantIds: result.relevant_memory_ids.length,
		flags: result.flags,
	});

	return result;
}

/**
 * Filter raw memCtx down to just the curator-approved memory IDs.
 */
export function buildCuratedPrepend(curatorResult, memories = []) {
	if (!curatorResult) return '';

	const { register, flags, relevant_memory_ids, reasoning } = curatorResult;

	const sections = [];
	sections.push(`[Curator | register=${register}${flags.length ? ` | flags=${flags.join(',')}` : ''}]`);
	if (reasoning) sections.push(`Curator note: ${reasoning}`);

	if (relevant_memory_ids.length && memories.length) {
		const byId = new Map(memories.map(m => [m.id, m]));
		const chosen = relevant_memory_ids.map(id => byId.get(id)).filter(Boolean);
		if (chosen.length) {
			sections.push('Curator-selected relevant memories:');
			for (const m of chosen) {
				sections.push(`- [${m.category}] ${(m.fact || '').slice(0, 200)}`);
			}
		}
	}

	return sections.join('\n');
}
