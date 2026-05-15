/**
 * Cloudflare AI Service — background processing layer.
 *
 * Data-driven cascade assignments (2026-05-15, post-bench):
 *   - mode_classifier         qwen-coder-32b → llama-4-scout-17b (with 3.1-fl-min resilience tier)
 *   - triple_extraction       llama-4-scout-17b → qwen-coder-32b
 *   - mood_tagging            qwen-coder-32b → llama-4-scout-17b
 *   - memory_dedup            llama-4-scout-17b → qwen-coder-32b
 *   - style_card              llama-4-scout-17b → qwen-coder-32b
 *   - interpretReaction       gemini-2.5-fl (thinking off) → llama-4-scout-17b
 */

import {
	geminiBackgroundGenerate,
	runCascade,
	FLASH_3_MODEL,
	FLASH_LITE_31_MODEL,
	FLASH_LITE_25_MODEL,
	PRO_31_MODEL,
	PRO_25_MODEL,
	KIMI_MODEL,
	GEMMA_MODEL,
	QWEN_CODER_32B_MODEL,
	LLAMA_4_SCOUT_MODEL,
} from '../lib/ai/gemini';

const MODELS = {
	tiny: '@cf/meta/llama-3.2-1b-instruct',                // legacy reference
	balanced: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',   // legacy reference; retained for tagger fallback
	context: '@cf/zai-org/glm-4.7-flash',                  // legacy reference
	tools: '@cf/google/gemma-4-26b-a4b-it',                // legacy reference
};

// Data-driven cascade definitions (post-bench 2026-05-15).
const SUMMARISATION_TIERS = [
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL,   opts: { maxOutputTokens: 3000 }, label: 'summ:llama-4-scout' },
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL,  opts: { maxOutputTokens: 3000 }, label: 'summ:qwen-coder-32b' },
];

const STYLE_CARD_TIERS = [
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL,   opts: { maxOutputTokens: 3000 }, label: 'style:llama-4-scout' },
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL,  opts: { maxOutputTokens: 3000 }, label: 'style:qwen-coder-32b' },
];

const TRIPLE_EXTRACTION_TIERS = [
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL,   opts: { maxOutputTokens: 600 },  label: 'triple:llama-4-scout' },
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL,  opts: { maxOutputTokens: 600 },  label: 'triple:qwen-coder-32b' },
];

const MOOD_TAGGING_TIERS = [
	{ kind: 'cf', model: QWEN_CODER_32B_MODEL,  opts: { maxOutputTokens: 200 },  label: 'moodtag:qwen-coder-32b' },
	{ kind: 'cf', model: LLAMA_4_SCOUT_MODEL,   opts: { maxOutputTokens: 200 },  label: 'moodtag:llama-4-scout' },
];

// interpretReaction cascade (post-bench 2026-05-15, Roma spec):
//   Tier 1: gemini-2.5-flash-lite, thinking off (thinkingBudget: 0)
//   Tier 2: llama-4-scout-17b (CF, ~1.8s on extraction-shape tasks)
const REACTION_TIERS = [
	{ kind: 'gemini', model: FLASH_LITE_25_MODEL, opts: { maxOutputTokens: 200, thinkingBudget: 0 }, label: 'reaction:2.5-fl-off' },
	{ kind: 'cf',     model: LLAMA_4_SCOUT_MODEL, opts: { maxOutputTokens: 200 },                    label: 'reaction:llama-4-scout' },
];

/**
 * Run a simple text completion on a CF AI model. Legacy helper kept for
 * tagConversationMode fallback tiers. Returns text or null.
 */
export async function cfAiGenerate(env, model, prompt, systemPrompt = '') {
	if (!env.AI) return null;
	try {
		const messages = [];
		if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
		messages.push({ role: 'user', content: prompt });

		const result = await env.AI.run(model, { messages, max_tokens: 512 }, {
			headers: { 'x-session-affinity': 'xaridotis-bg' },
		});
		return result?.response || null;
	} catch (e) {
		console.error(`CF AI error (${model}):`, e.message);
		return null;
	}
}


/**
 * Extract observations + knowledge-graph triples from a conversation exchange.
 *
 * Roma cascade: gemini-3.1-flash-lite-preview · thinkingLevel: medium (single tier).
 */
export async function extractObservation(env, userText, botResponse) {
	const prompt = `You observed this exchange:
USER: ${userText.slice(0, 400)}
BOT: ${botResponse.slice(0, 300)}

Did you learn anything NEW about this person? Look for:
- Implicit preferences not stated directly
- Behavioural patterns
- New interests, goals, or life events
- Emotional patterns

If yes, respond with ONLY: OBSERVATION: [your observation]

Also extract relational connections as triples.
Format: TRIPLE: Subject | Predicate | Object
Examples: TRIPLE: Roman | enjoys | Coffee, TRIPLE: Gym | reduces | Anxiety

If nothing new, respond: NOTHING_NEW`;
	const sys = 'You are a silent observer. Be concise. Only note genuinely new information.';

	return runCascade(env, prompt, sys, TRIPLE_EXTRACTION_TIERS);
}

/**
 * Tag a mood entry with clinical categories.
 *
 * Roma cascade: gemini-3.1-flash-lite-preview · thinkingLevel: minimal (single tier).
 * Aligned with the conversation tagging classifier — same model, same tier.
 */
export async function tagMoodEntry(env, score, emotions, note) {
	const prompt = `Mood score: ${score}/10. Emotions: ${(emotions || []).join(', ')}. Note: ${(note || 'none').slice(0, 200)}.

Tag this entry with 1-3 clinical categories from this list:
depressive_episode, anxiety_state, hypomanic_signs, stable_baseline, mixed_state, crisis_risk, productive_phase, social_withdrawal, sleep_disruption, medication_response

Respond with ONLY the tags, comma-separated. Example: anxiety_state, sleep_disruption`;
	const sys = 'You are a clinical tagger. Return only tags, no explanation.';

	return runCascade(env, prompt, sys, MOOD_TAGGING_TIERS);
}

/**
 * First-pass memory deduplication.
 *
 * Roma cascade (Long summarisation): Flash 3 → 3.1 FL → Kimi → 2.5 Pro b128 → Gemma.
 */
export async function deduplicateMemories(env, memories) {
	if (!memories.length) return { groups: [], duplicates: [] };

	const memoryList = memories.map((m, i) => `[${i}] [${m.category}] ${m.fact} (${m.created_at || 'unknown'})`).join('\n');

	const prompt = `Here are ${memories.length} stored memories. Identify:
1. DUPLICATES: memories that say the same thing (list pairs of indices)
2. CONTRADICTIONS: memories where a newer one updates/replaces an older one (list pairs as [older, newer])
3. GROUPS: memories that relate to the same topic (list groups of indices with a label)

MEMORIES:
${memoryList}

Respond in this exact format:
DUPLICATES: [0,5], [3,7]
CONTRADICTIONS: [2,9], [4,11]
GROUP: ADHD management: [1,4,8,12]
GROUP: Coffee preferences: [2,9]

If none found, write: DUPLICATES: none / CONTRADICTIONS: none`;
	const sys = 'You are a data organiser. Be precise with indices. For contradictions, always list the OLDER memory first in each pair.';

	const result = await runCascade(env, prompt, sys, SUMMARISATION_TIERS);

	const duplicates = [];
	const contradictions = [];
	const groups = [];

	if (result) {
		const dupMatch = result.match(/DUPLICATES:\s*(.+)/);
		if (dupMatch && !dupMatch[1].includes('none')) {
			const pairs = dupMatch[1].matchAll(/\[(\d+),\s*(\d+)\]/g);
			for (const p of pairs) duplicates.push([parseInt(p[1]), parseInt(p[2])]);
		}

		const contraMatch = result.match(/CONTRADICTIONS:\s*(.+)/);
		if (contraMatch && !contraMatch[1].includes('none')) {
			const pairs = contraMatch[1].matchAll(/\[(\d+),\s*(\d+)\]/g);
			for (const p of pairs) contradictions.push([parseInt(p[1]), parseInt(p[2])]);
		}

		const groupMatches = result.matchAll(/GROUP:\s*(.+?):\s*\[([^\]]+)\]/g);
		for (const g of groupMatches) {
			const indices = g[2].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
			groups.push({ label: g[1].trim(), indices });
		}
	}

	return { groups, duplicates, contradictions };
}



/**
 * Classify the conversational mode of the user's most recent message.
 *
 * Roma cascade (Routing classifier, Arch B only): 3.1 FL minimal (Tier 1).
 * Multi-tier fallback retained as resilience anchor so the classifier never
 * returns null on Gemini outage.
 *   Tier 1: Gemini 3.1 Flash-Lite preview, thinkingLevel='minimal' (cap 2500ms)
 *   Tier 2: Llama 3.1 8B via CF                (cap 1500ms)
 *   Tier 3: Gemma 4 26B via CF                 (cap 3500ms)
 *   Tier 4: Gemini 3-flash-preview             (cap 2500ms)
 *   Floor:  Heuristic regex                    (instant)
 */
export async function tagConversationMode(env, userText, recentHistory = []) {
	if (!userText || userText.length < 2) {
		return { mode: 'transactional', confidence: 'low', source: 'default-empty' };
	}

	const contextLines = recentHistory.slice(-4).map(turn => {
		const role = turn.role === 'model' ? 'BOT' : 'USER';
		const text = (turn.parts || []).map(p => p.text).filter(Boolean).join(' ').slice(0, 200);
		return text ? `${role}: ${text}` : '';
	}).filter(Boolean).join('\n');

	const prompt = `Classify the user's most recent message into ONE of these modes:

venting — emotional discharge, repeating a painful thought, not asking for help, just needs to be heard. Examples: "He's ignoring me", "I can't stop thinking about it", "I'm just done"
processing — actively trying to understand or work through something, open to questions and reflection. Examples: "Why does this keep happening?", "Help me think this through", "What do you make of this?"
transactional — practical request: reminder, lookup, code, info, scheduling. No emotional content. Examples: "Remind me at 9am", "What time is it in Tokyo?", "Fix this code"
crisis — severe distress: suicidal thoughts, self-harm, dissociation, total breakdown, mood 0-1 territory. Examples: "I want to die", "I can't feel anything", "I can't go on"

RECENT CONVERSATION:
${contextLines || '(no prior context)'}

CURRENT USER MESSAGE: ${userText.slice(0, 400)}

Respond with ONLY one word: venting, processing, transactional, or crisis.`;

	const systemPrompt = 'You classify conversational modes. Output only one word.';

	const chainStartedAt = Date.now();
	const TOTAL_CHAIN_BUDGET_MS = 8000;
	const budgetLeft = () => Math.max(0, TOTAL_CHAIN_BUDGET_MS - (Date.now() - chainStartedAt));
	const tierTimeout = (preferredMs) => Math.min(preferredMs, budgetLeft());

	let mode = null;
	let source = null;

	// Tier 1: Qwen 2.5 Coder 32B via CF (215ms P50 in bench, 100% parse)
	if (!mode && env.AI && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithCfModel(env, QWEN_CODER_32B_MODEL, prompt, systemPrompt),
			tierTimeout(1500)
		);
		if (mode) source = 'qwen-coder-32b';
	}

	// Tier 2: Llama 4 Scout 17B via CF (329ms P50 in bench, 100% parse)
	if (!mode && env.AI && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithCfModel(env, LLAMA_4_SCOUT_MODEL, prompt, systemPrompt),
			tierTimeout(1500)
		);
		if (mode) source = 'llama-4-scout-17b';
	}

	// Tier 3 (cross-provider resilience): Gemini 3.1 Flash-Lite minimal
	if (!mode && env.GEMINI_API_KEY && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithGemini31FLMinimal(env, prompt, systemPrompt),
			tierTimeout(2500)
		);
		if (mode) source = 'gemini-3.1-fl-min';
	}

	if (!mode) {
		mode = _heuristicGuess(userText);
		source = 'heuristic-only';
	}

	const confidence = _computeConfidence(userText, mode, source);
	return { mode, confidence, source };
}

// ---- Provider helpers ----

async function _tryProvider(fn, timeoutMs) {
	const t0 = Date.now();
	try {
		let didTimeout = false;
		const result = await Promise.race([
			fn(),
			new Promise(resolve => setTimeout(() => {
				didTimeout = true;
				resolve(null);
			}, timeoutMs)),
		]);
		const elapsed = Date.now() - t0;
		if (didTimeout) {
			console.warn(`tagConversationMode: provider timed out after ${elapsed}ms (cap ${timeoutMs}ms)`);
			return null;
		}
		const mode = _extractMode(result);
		if (!mode) {
			const rawType = typeof result;
			const rawPreview = result === null ? '(null)'
				: result === undefined ? '(undefined)'
				: rawType === 'string' ? `"${result.slice(0, 500)}"`
				: JSON.stringify(result)?.slice(0, 500) || '(unstringifiable)';
			console.warn(`tagConversationMode: provider returned no parseable mode in ${elapsed}ms. Raw type: ${rawType}, preview: ${rawPreview}`);
		}
		return mode;
	} catch (err) {
		const elapsed = Date.now() - t0;
		console.warn(`tagConversationMode: provider failed in ${elapsed}ms: ${err.message?.slice(0, 200)}`);
		return null;
	}
}

async function _classifyWithGemma(env, prompt, systemPrompt) {
	const { runCfAi } = await import('../lib/ai-gateway.js');
	const result = await runCfAi(env.AI, '@cf/google/gemma-4-26b-a4b-it', {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: prompt },
		],
		temperature: 0.2,
		max_tokens: 2000,
	});
	const text = result?.choices?.[0]?.message?.content || result?.response;
	return text || result;
}

// Generic CF model classifier — used by Tier 1 (qwen-coder) and Tier 2 (scout)
// in tagConversationMode. Replaces the model-specific _classifyWithGemma /
// _classifyWithLlama8B helpers (those are now dead code, kept for compat).
async function _classifyWithCfModel(env, modelBinding, prompt, systemPrompt) {
	const { runCfAi } = await import('../lib/ai-gateway.js');
	const result = await runCfAi(env.AI, modelBinding, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: prompt },
		],
		temperature: 0.2,
		max_tokens: 64,
	}, {
		headers: { 'x-session-affinity': 'xaridotis-tag' },
	});
	const text = result?.choices?.[0]?.message?.content || result?.response;
	return text || result;
}

async function _classifyWithGemini(env, prompt, systemPrompt, modelTag) {
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	const model = modelTag === '@gemini-flash'
		? FLASH_3_MODEL
		: FLASH_LITE_31_MODEL;
	const response = await ai.models.generateContent({
		model,
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		config: {
			systemInstruction: systemPrompt,
			temperature: 0.2,
			maxOutputTokens: 2000,
		},
	});
	let text = '';
	if (typeof response?.text === 'string') {
		text = response.text;
	} else if (typeof response?.text === 'function') {
		try { text = response.text() || ''; } catch { /* fall through */ }
	}
	if (!text) {
		text = response?.candidates?.[0]?.content?.parts
			?.filter(p => p.text && !p.thought)
			?.map(p => p.text)
			?.join('') || '';
	}
	return text || response;
}

async function _classifyWithLlama8B(env, prompt, systemPrompt) {
	const result = await env.AI.run(MODELS.balanced, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: prompt },
		],
		max_tokens: 64,
	}, {
		headers: { 'x-session-affinity': 'xaridotis-tag' },
	});
	return result?.response || result;
}

async function _classifyWithGemini31FLMinimal(env, prompt, systemPrompt) {
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	const response = await ai.models.generateContent({
		model: FLASH_LITE_31_MODEL,
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		config: {
			systemInstruction: systemPrompt,
			temperature: 0.2,
			maxOutputTokens: 2000,
			thinkingConfig: { thinkingLevel: 'minimal' },
		},
	});
	let text = '';
	if (typeof response?.text === 'string') {
		text = response.text;
	} else if (typeof response?.text === 'function') {
		try { text = response.text() || ''; } catch { /* fall through */ }
	}
	if (!text) {
		text = response?.candidates?.[0]?.content?.parts
			?.filter(p => p.text && !p.thought)
			?.map(p => p.text)
			?.join('') || '';
	}
	return text || response;
}

function _extractMode(rawText) {
	if (!rawText || typeof rawText !== 'string') return null;
	const match = rawText.toLowerCase().match(/\b(venting|processing|transactional|crisis)\b/);
	return match ? match[1] : null;
}

// ---- Heuristic confidence layer ----

function _messageFeatures(text) {
	const t = (text || '').toLowerCase();
	return {
		length: t.length,
		hasQuestion: /\?/.test(t),
		hasCrisisKeyword: /\b(suicid|kill (myself|me)|want to die|self.?harm|can(?:no|')?t go on|don'?t want to (be here|live)|end (it|things)|disappear forever|no point (in )?(living|going on|being here)|nothing matters anymore)\b/.test(t),
		hasEmotionalKeyword: /\b(anxious|panic|hate|crying|broken|empty|lonely|hopeless|terrified|hurts?|aching|sick of|done with|exhausted|drained|miserable)\b/.test(t),
		hasProcessingKeyword: /\b(why|how come|figure out|make sense|understand|wonder|curious|trying to|help me think|what do you (think|make))\b/.test(t),
		hasTransactionalKeyword: /\b(remind|set a|schedule|book|deploy|fix|debug|run|find|search|look up|what.?s the|when.?s|where.?s|who.?s|how do i)\b/.test(t),
		hasRepeatedThought: /\b(again|still|always|every|keeps?|keeps happening|same thing|won'?t stop)\b/.test(t),
		isShort: t.length < 30,
	};
}

function _heuristicGuess(text) {
	const f = _messageFeatures(text);
	if (f.hasCrisisKeyword) return 'crisis';
	if (f.hasTransactionalKeyword && !f.hasEmotionalKeyword) return 'transactional';
	if (f.hasProcessingKeyword && f.hasQuestion) return 'processing';
	if (f.hasEmotionalKeyword || f.hasRepeatedThought) return 'venting';
	return 'transactional';
}

function _computeConfidence(text, mode, source) {
	if (source === 'heuristic-only') return 'low';

	const f = _messageFeatures(text);

	switch (mode) {
		case 'crisis':
			if (f.hasCrisisKeyword) return 'high';
			if (f.hasEmotionalKeyword) return 'medium';
			return 'low';

		case 'venting':
			if (f.hasEmotionalKeyword && !f.hasQuestion) return 'high';
			if (f.hasRepeatedThought || f.hasEmotionalKeyword) return 'medium';
			if (f.hasTransactionalKeyword) return 'low';
			return 'medium';

		case 'processing':
			if (f.hasProcessingKeyword && f.hasQuestion) return 'high';
			if (f.hasQuestion || f.hasProcessingKeyword) return 'medium';
			if (f.isShort && !f.hasQuestion) return 'low';
			return 'medium';

		case 'transactional':
			if (f.hasTransactionalKeyword) return 'high';
			if (f.isShort && !f.hasEmotionalKeyword) return 'medium';
			if (f.hasEmotionalKeyword || f.hasCrisisKeyword) return 'low';
			return 'medium';

		default:
			return 'low';
	}
}


/**
 * Interpret a user's emoji reaction in the context of the bot message.
 *
 * Roma cascade (Persona evolution observations): Gemma → Flash 3 → 3.1 FL → Pro 3.1 default → 2.5 Pro GA.
 */
export async function interpretReaction(env, emoji, botMessageText) {
	if (!emoji || !botMessageText) return null;

	const prompt = `The user reacted with ${emoji} to this message you (the bot) sent them:
"${botMessageText.slice(0, 280)}"

Extract ONE concise meta-behavioural rule about how the user prefers you to communicate.
Focus on: tone, length, phrasing, directness, humour, clinical vocabulary, formatting.
Ignore the topic itself — focus on HOW the message was written.

Output format (strict): one line only, under 100 characters.
Start with "User" and a verb (liked/disliked/preferred/appreciated/etc).
Example: "User appreciated the short, non-clinical tone"
Example: "User disliked the framework name-drop"
Example: "User found the lecturing repetitive"

If the reaction is ambiguous or carries no useful signal, respond with exactly: SKIP`;
	const sys = 'You extract communication preferences from user reactions. Be specific about HOW the user prefers the bot to communicate, not what the topic was. Return ONE line only.';

	const response = await runCascade(env, prompt, sys, REACTION_TIERS);

	if (!response || response.trim() === 'SKIP') return null;

	const insight = response
		.split('\n')
		.map(l => l.trim())
		.find(l => l.length > 10 && l.length < 200);

	if (!insight || !/^user\s/i.test(insight)) return null;

	const lower = insight.toLowerCase();
	const negative = /(dislike|disliked|found.+(repetitive|annoying|robotic|clinical)|too\s(long|much|clinical)|complained|preferred\s(less|shorter)|criticised|criticized)/;
	const positive = /(liked|appreciated|enjoyed|loved|found.+(helpful|natural|warm)|preferred\s(more|this)|welcomed)/;

	let sentiment = 'neutral';
	if (negative.test(lower)) sentiment = 'negative';
	else if (positive.test(lower)) sentiment = 'positive';

	return { insight: insight.slice(0, 150), sentiment };
}


/**
 * Consolidate feedback memories into an updated style card.
 *
 * Roma cascade (Style card consolidation, daily 04:00 cron):
 *   Gemma → Flash 3 → 3.1 FL → Kimi.
 */
export async function consolidateStyleCard(env, currentStyleCard, feedbackInsights) {
	if (!feedbackInsights.length) return null;

	const feedbackList = feedbackInsights.map((f, i) => `${i + 1}. ${f}`).join('\n');

	const prompt = `You are updating a user's communication style card based on their recent feedback signals.

CURRENT STYLE CARD:
${currentStyleCard}

RECENT FEEDBACK FROM USER REACTIONS:
${feedbackList}

RULES:
- Integrate the feedback into the existing style card naturally.
- If feedback contradicts an existing preference, UPDATE the preference (newer feedback wins).
- If feedback confirms an existing preference, STRENGTHEN the wording slightly.
- If feedback reveals something entirely new, ADD a line in the appropriate section.
- PRESERVE the existing structure and sections.
- Do NOT add commentary, explanations, or meta-text.
- Do NOT wrap in markdown code blocks.
- Return ONLY the updated style card text.`;
	const sys = 'You update style cards by integrating user feedback. Return only the updated style card, no commentary.';

	const result = await runCascade(env, prompt, sys, STYLE_CARD_TIERS);

	if (!result || result.length < 100) return null;

	return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '').trim();
}

export { MODELS };
