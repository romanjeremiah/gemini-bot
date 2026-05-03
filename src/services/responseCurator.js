// Pre-response curator (Phase 4).
//
// Before the main model generates a response, a cheap fast model reads the
// incoming message + retrieved memCtx + recent history and produces a curated
// summary that gets PREPENDED to the prompt. The main model then receives a
// tighter, decision-ready context instead of raw memory dumps.
//
// What the curator outputs:
//   - relevant_memory_ids: which memCtx memories actually relate to this turn
//   - register_hint: 'casual' | 'warm' | 'technical' | 'urgent' (override our regex)
//   - flags: array of structured signals ('crisis', 'med_question', 'positive_state',
//            'recall_request', 'project_continuity', etc)
//   - reasoning: 1-2 sentence summary the main model can read to ground itself
//
// When NOT to curate (early-exit):
//   - userText < 30 chars (no signal worth analysing)
//   - active health check-in (register already locked)
//   - no memCtx and no semanticCtx (nothing to curate)
//
// Latency budget: ~200-400ms via Flash-Lite. Adds a single extra Gemini call
// per substantive turn. Cheap given Flash-Lite pricing.

import { FLASH_LITE_TEXT_MODEL } from '../lib/ai/gemini';
import { GoogleGenAI } from '@google/genai';
import { log } from '../lib/logger';

// Direct Flash-Lite call for curator. We DO NOT use generateShortResponse
// because it appends SHORT_RESPONSE_GUIDE ("2-4 complete sentences, no
// markdown") which conflicts with our JSON-only instruction. Gemma in
// particular tends to honour the natural-language guide and produce
// truncated/contaminated JSON. A direct Flash-Lite call with explicit
// JSON instruction and no contamination is more reliable.
//
// Latency budget: ~400-1000ms typical. Caller should still treat curator
// as best-effort — a null return must never break the main path.
let _curatorAi = null;
function getCuratorAi(env) {
	if (!_curatorAi) _curatorAi = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	return _curatorAi;
}

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
- If the message is too short to analyse meaningfully, return register: "casual", flags: ["short_ack"], relevant_memory_ids: [], reasoning: "Brief acknowledgement, no substantive content."`;

/**
 * Curate context for an incoming message. Returns a structured analysis the
 * main model can use to ground its reply.
 *
 * @param {Object} env
 * @param {Object} args
 * @param {string} args.userText - the incoming user message
 * @param {Array} args.memories - array of {id, category, fact} objects from memCtx
 * @param {Array} args.recentHistory - last 4 user/model turns from KV history
 * @param {string} args.semanticCtxPreview - first 500 chars of semantic context (optional)
 * @returns {Promise<{register: string, flags: string[], relevant_memory_ids: number[], reasoning: string} | null>}
 *   Returns null on early-exit (not worth curating) or on failure (caller falls back to raw memCtx).
 */
export async function curateContext(env, { userText, memories = [], recentHistory = [], semanticCtxPreview = '' }) {
	// Early exit: nothing to curate
	if (!userText || userText.length < 30) {
		return null;
	}
	if (!memories.length && !semanticCtxPreview) {
		return null;
	}

	const t0 = Date.now();

	// Build the curator input. Keep it lean — we want sub-400ms latency.
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

	const input = `INCOMING USER MESSAGE:\n${userText.slice(0, 800)}\n\nRETRIEVED MEMORIES:\n${memorySection}\n\nRECENT HISTORY:\n${historySection}\n\n${semanticCtxPreview ? `SEMANTIC CONTEXT:\n${semanticCtxPreview.slice(0, 400)}\n\n` : ''}Produce the JSON analysis.`;

	let rawText;
	try {
		const ai = getCuratorAi(env);
		const response = await ai.models.generateContent({
			model: FLASH_LITE_TEXT_MODEL,
			contents: [{ role: 'user', parts: [{ text: input }] }],
			config: {
				systemInstruction: CURATOR_PROMPT,
				temperature: 0.3, // Lower temp for structured output
				maxOutputTokens: 600, // Curator output is small; tight budget = less truncation risk
				responseMimeType: 'application/json', // Force JSON mode — model returns parseable JSON directly
			},
		});
		rawText = response.candidates?.[0]?.content?.parts
			?.filter(p => p.text && !p.thought)
			?.map(p => p.text)
			?.join('') || '';
	} catch (err) {
		log.warn('curator_call_failed', { msg: err.message });
		return null;
	}

	if (!rawText) {
		log.warn('curator_empty_response', { userTextLen: userText.length });
		return null;
	}

	// Strip markdown fences if present (defensive — responseMimeType: 'application/json'
	// should prevent these but Flash-Lite occasionally ignores it).
	const cleaned = rawText.replace(/```json|```/g, '').trim();

	// Try direct parse first (responseMimeType:json should give us clean JSON).
	let parsed = null;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		// Fallback 1: greedy regex extraction (handles preamble/postamble text).
		const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				parsed = JSON.parse(jsonMatch[0]);
			} catch { /* fall through to truncation recovery */ }
		}

		// Fallback 2: truncation recovery. If response was cut off mid-JSON,
		// brace-balance forward from the first `{` and append closing braces
		// to whatever was generated. This recovers register + leading flags
		// even when reasoning got cut off.
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
				// Close any unclosed strings, arrays, and objects.
				if (inString) recovered += '"';
				// Trailing comma before closing? Strip it.
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

	// Validate shape — reject malformed outputs that could break the main path.
	const register = ['casual', 'warm', 'technical', 'urgent'].includes(parsed.register) ? parsed.register : 'casual';
	const flags = Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string').slice(0, 8) : [];
	const relevantIds = Array.isArray(parsed.relevant_memory_ids)
		? parsed.relevant_memory_ids.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 12)
		: [];
	const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : '';

	const elapsed = Date.now() - t0;
	log.info('curator_complete', {
		elapsed_ms: elapsed,
		register,
		flagCount: flags.length,
		relevantIds: relevantIds.length,
		flags,
	});

	return { register, flags, relevant_memory_ids: relevantIds, reasoning };
}

/**
 * Filter raw memCtx down to just the curator-approved memory IDs, formatted as
 * a compact prepend block for the main prompt. Returns the empty string if no
 * IDs were chosen.
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
