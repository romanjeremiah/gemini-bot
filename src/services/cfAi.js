/**
 * Cloudflare AI Service — lightweight edge models for background processing.
 *
 * Offloads non-user-facing tasks from Gemini to free Workers AI models.
 * 10,000 neurons/day free. Estimated usage: ~400 neurons/day.
 *
 * Models used:
 * - @cf/meta/llama-3.2-1b-instruct: sentiment, tagging, simple extraction (~5 neurons/call)
 * - @cf/meta/llama-3.1-8b-instruct-fp8-fast: triple extraction, observation (~13 neurons/call)
 * - @cf/zai-org/glm-4.7-flash: long-text summarisation, memory consolidation (~25 neurons/call)
 * - @cf/google/gemma-4-26b-a4b-it: function calling for low-stakes tools (Phase 2)
 */

const MODELS = {
	tiny: '@cf/meta/llama-3.2-1b-instruct',        // Cheapest: sentiment, tagging
	balanced: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', // Mid: triples, observations
	context: '@cf/zai-org/glm-4.7-flash',           // 131K context: summarisation
	tools: '@cf/google/gemma-4-26b-a4b-it',         // Function calling: low-stakes tools (Phase 2)
};

/**
 * Run a simple text completion on a CF AI model.
 * Returns the generated text or null on failure.
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
 * Extract observations from a conversation using the tiny model.
 * Replaces Gemini Flash for silent observation.
 */
export async function extractObservation(env, userText, botResponse) {
	return cfAiGenerate(env, MODELS.balanced,
		`You observed this exchange:
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

If nothing new, respond: NOTHING_NEW`,
		'You are a silent observer. Be concise. Only note genuinely new information.'
	);
}

/**
 * Tag a mood entry with clinical categories using the tiny model.
 */
export async function tagMoodEntry(env, score, emotions, note) {
	return cfAiGenerate(env, MODELS.tiny,
		`Mood score: ${score}/10. Emotions: ${(emotions || []).join(', ')}. Note: ${(note || 'none').slice(0, 200)}.

Tag this entry with 1-3 clinical categories from this list:
depressive_episode, anxiety_state, hypomanic_signs, stable_baseline, mixed_state, crisis_risk, productive_phase, social_withdrawal, sleep_disruption, medication_response

Respond with ONLY the tags, comma-separated. Example: anxiety_state, sleep_disruption`,
		'You are a clinical tagger. Return only tags, no explanation.'
	);
}

/**
 * First-pass memory deduplication using the large context model.
 * Groups related memories and identifies duplicates before Gemini Pro consolidation.
 */
export async function deduplicateMemories(env, memories) {
	if (!memories.length) return { groups: [], duplicates: [] };

	const memoryList = memories.map((m, i) => `[${i}] [${m.category}] ${m.fact} (${m.created_at || 'unknown'})`).join('\n');

	const result = await cfAiGenerate(env, MODELS.context,
		`Here are ${memories.length} stored memories. Identify:
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

If none found, write: DUPLICATES: none / CONTRADICTIONS: none`,
		'You are a data organiser. Be precise with indices. For contradictions, always list the OLDER memory first in each pair.'
	);

	// Parse the response
	const duplicates = [];
	const contradictions = [];
	const groups = [];

	if (result) {
		const dupMatch = result.match(/DUPLICATES:\s*(.+)/);
		if (dupMatch && !dupMatch[1].includes('none')) {
			const pairs = dupMatch[1].matchAll(/\[(\d+),\s*(\d+)\]/g);
			for (const p of pairs) duplicates.push([parseInt(p[1]), parseInt(p[2])]);
		}

		// Contradictions: [older, newer] — the older one should be removed
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
 * Returns { mode, confidence, source } where mode is one of:
 *   'venting' | 'processing' | 'transactional' | 'crisis'
 *
 * - venting: emotional discharge, looking to be heard, not asking for solutions
 * - processing: actively trying to understand or work through something, open to questions
 * - transactional: practical request (reminder, code, lookup, info)
 * - crisis: severe distress, suicidal ideation, dissociation, mood 0-1 territory
 *
 * Provider chain (per-tier timeouts vary by model; total chain capped at 8000ms):
 *   Tier 1: Llama 3.1 8B (cap 1500ms)   — fast, free, resilience anchor
 *   Tier 2: Gemma 4 26B (cap 3500ms)    — free, accuracy when time permits
 *   Tier 3: Gemini Flash (cap 2500ms)   — reliable production fallback
 *   Tier 4: Gemini Flash-Lite (cap 2000ms) — last resort (most overloaded)
 *   Floor:  Heuristic regex (instant)   — never null
 *
 * Order optimises for resilience first, accuracy second. Llama 8B handles
 * the easy 80% in <1s. Gemma reasons through nuance when needed. Gemini
 * Flash is the production-grade safety net. Flash-Lite is last because
 * it's the most failure-prone preview model.
 *
 * Total cap of 8000ms means worst case the entire chain completes within
 * the budget of the parallel Promise.all in handlers.js. The tagger runs
 * alongside memory fetches so under steady-state (Llama succeeds in tier 1)
 * its latency hides under the slowest memory op.
 *
 * Confidence is computed locally from message features (length, punctuation,
 * keyword agreement) and reflects how strongly the heuristics support the
 * model's classification. Returned as 'high' | 'medium' | 'low'.
 *
 * @param {object} env - Worker env with AI + GEMINI_API_KEY bindings
 * @param {string} userText - The current user message
 * @param {Array<{role:string,parts:Array}>} recentHistory - Last 4-6 turns from chat history
 * @returns {Promise<{mode: 'venting'|'processing'|'transactional'|'crisis', confidence: 'high'|'medium'|'low', source: string}>}
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

	// Per-tier timeouts vary by model latency profile. Total chain budget
	// 8000ms. If we burn the total budget on a slow tier, skip remaining
	// tiers and drop to the heuristic floor.
	const chainStartedAt = Date.now();
	const TOTAL_CHAIN_BUDGET_MS = 8000;
	const budgetLeft = () => Math.max(0, TOTAL_CHAIN_BUDGET_MS - (Date.now() - chainStartedAt));
	const tierTimeout = (preferredMs) => Math.min(preferredMs, budgetLeft());

	// Stop on first valid label.
	let mode = null;
	let source = null;

	// Tier 1: Llama 3.1 8B (resilience anchor — fast, free, very reliable)
	if (!mode && env.AI && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithLlama8B(env, prompt, systemPrompt),
			tierTimeout(1500)
		);
		if (mode) source = 'llama-8b';
	}

	// Tier 2: Gemma 4 26B (accuracy via reasoning, but slower)
	if (!mode && env.AI && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithGemma(env, prompt, systemPrompt),
			tierTimeout(3500)
		);
		if (mode) source = 'gemma-4';
	}

	// Tier 3: Gemini Flash (production-grade fallback)
	if (!mode && env.GEMINI_API_KEY && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithGemini(env, prompt, systemPrompt, '@gemini-flash'),
			tierTimeout(2500)
		);
		if (mode) source = 'gemini-flash';
	}

	// Tier 4: Gemini Flash-Lite (last resort — most overloaded preview model)
	if (!mode && env.GEMINI_API_KEY && budgetLeft() > 100) {
		mode = await _tryProvider(
			() => _classifyWithGemini(env, prompt, systemPrompt, '@gemini-flash-lite'),
			tierTimeout(2000)
		);
		if (mode) source = 'gemini-flash-lite';
	}

	// Last-resort floor: heuristic-only. Better than null because the
	// conversation-state block ALWAYS gets a mode — Gemini Pro never sees
	// 'mode: unknown', which would invite hallucination.
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
			// Surface the FULL raw response (up to 500 chars) so we can tell the
			// difference between: (a) genuinely empty model output, (b) response
			// shape mismatch where the answer is in an unexpected field, and
			// (c) thinking-tokens consuming the entire max_tokens budget.
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
	// max_tokens: 2000 — Gemma 4 26B reasons before answering, and that reasoning
	// counts against this ceiling. Both 16 and 128 truncated mid-reasoning before
	// the model could produce its one-word answer (finish_reason: "length").
	// 2000 is generous; the model will hit its natural EOS far before this.
	// The 1500ms tier wall-clock cap is the real safety limit; this is just
	// the token budget upper bound.
	const result = await runCfAi(env.AI, '@cf/google/gemma-4-26b-a4b-it', {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: prompt },
		],
		temperature: 0.2,
		max_tokens: 2000,
	});
	// Try the standard fields first; if both empty, return the raw object so
	// _tryProvider's no-parse log can show what shape actually came back.
	const text = result?.choices?.[0]?.message?.content || result?.response;
	return text || result;
}

async function _classifyWithGemini(env, prompt, systemPrompt, modelTag) {
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	const model = modelTag === '@gemini-flash'
		? 'gemini-3-flash-preview'
		: 'gemini-3.1-flash-lite-preview';
	// maxOutputTokens: 2000 — same reasoning as Gemma. Gemini 3.x preview
	// models have internal thinking budgets that consume output tokens before
	// the visible answer. 16 and 128 both hit length limit. The 1500ms tier
	// wall-clock cap is the real safety limit; this is just the token budget.
	const response = await ai.models.generateContent({
		model,
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		config: {
			systemInstruction: systemPrompt,
			temperature: 0.2,
			maxOutputTokens: 2000,
		},
	});
	// Prefer the SDK's stable .text accessor (newer @google/genai versions
	// expose this as a getter that aggregates all text parts and ignores
	// thought/tool parts). Fall back to manual parts walking for older SDK
	// versions. If both fail, return the raw response so _tryProvider's
	// no-parse log can show what came back — e.g. blockReason, sdkHttpResponse
	// wrapper, or all-thoughts content.
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
	// Llama 3.1 8B is the resilience anchor: fast, reliable, accurate enough
	// for nuanced classification without the reasoning overhead of Gemma 4.
	// Direct env.AI.run (no gateway) keeps the call cheap and isolates this
	// from gateway-side failures.
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

function _extractMode(rawText) {
	if (!rawText || typeof rawText !== 'string') return null;
	const match = rawText.toLowerCase().match(/\b(venting|processing|transactional|crisis)\b/);
	return match ? match[1] : null;
}

// ---- Heuristic confidence layer ----

// Rough features extracted from the message itself. These are the signals
// any decent classifier would also use — they let us check whether the model
// agrees with the obvious surface-level reading.
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

// Local heuristic-only mode guess. Used when every provider fails.
function _heuristicGuess(text) {
	const f = _messageFeatures(text);
	if (f.hasCrisisKeyword) return 'crisis';
	if (f.hasTransactionalKeyword && !f.hasEmotionalKeyword) return 'transactional';
	if (f.hasProcessingKeyword && f.hasQuestion) return 'processing';
	if (f.hasEmotionalKeyword || f.hasRepeatedThought) return 'venting';
	return 'transactional';
}

// Confidence reflects whether the heuristics AGREE with the model's pick.
// 'high'   = strong corroborating signal (e.g. crisis label + crisis keyword)
// 'medium' = no strong contradiction
// 'low'    = surface features point a different direction OR floor was used
function _computeConfidence(text, mode, source) {
	if (source === 'heuristic-only') return 'low';

	const f = _messageFeatures(text);

	switch (mode) {
		case 'crisis':
			if (f.hasCrisisKeyword) return 'high';
			if (f.hasEmotionalKeyword) return 'medium';
			return 'low'; // crisis label without crisis keywords is suspicious

		case 'venting':
			if (f.hasEmotionalKeyword && !f.hasQuestion) return 'high';
			if (f.hasRepeatedThought || f.hasEmotionalKeyword) return 'medium';
			if (f.hasTransactionalKeyword) return 'low'; // probably wrong
			return 'medium';

		case 'processing':
			if (f.hasProcessingKeyword && f.hasQuestion) return 'high';
			if (f.hasQuestion || f.hasProcessingKeyword) return 'medium';
			if (f.isShort && !f.hasQuestion) return 'low'; // short non-question rarely processing
			return 'medium';

		case 'transactional':
			if (f.hasTransactionalKeyword) return 'high';
			if (f.isShort && !f.hasEmotionalKeyword) return 'medium';
			if (f.hasEmotionalKeyword || f.hasCrisisKeyword) return 'low'; // probably wrong
			return 'medium';

		default:
			return 'low';
	}
}


/**
 * Interpret a user's emoji reaction in the context of the bot message they reacted to.
 * Returns a short feedback insight or null if the reaction carries no useful signal.
 *
 * Uses the balanced 8B model for nuance — the 1B model struggles with emoji semantics.
 *
 * @param {object} env - Worker env with AI binding
 * @param {string} emoji - The reaction emoji (e.g. '👍', '🤔', '💯')
 * @param {string} botMessageText - Plain text of the message that was reacted to
 * @returns {Promise<{insight: string, sentiment: 'positive'|'negative'|'neutral'} | null>}
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

	const response = await cfAiGenerate(
		env,
		MODELS.balanced,
		prompt,
		'You extract communication preferences from user reactions. Be specific about HOW the user prefers the bot to communicate, not what the topic was. Return ONE line only.'
	);

	if (!response || response.trim() === 'SKIP') return null;

	// Take the first non-empty line, clean it up
	const insight = response
		.split('\n')
		.map(l => l.trim())
		.find(l => l.length > 10 && l.length < 200);

	if (!insight || !/^user\s/i.test(insight)) return null;

	// Quick sentiment classification from the insight wording
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
 * Takes the current style card + new feedback signals and produces
 * an updated style card that incorporates the learned preferences.
 *
 * Uses GLM-4.7-Flash (free, 131K context) since this is summarisation.
 *
 * @param {object} env - Worker env with AI binding
 * @param {string} currentStyleCard - The current style card text
 * @param {string[]} feedbackInsights - Array of feedback insights from reactions
 * @returns {Promise<string|null>} Updated style card or null on failure
 */
export async function consolidateStyleCard(env, currentStyleCard, feedbackInsights) {
	if (!feedbackInsights.length || !env.AI) return null;

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

	const result = await cfAiGenerate(env, MODELS.context, prompt,
		'You update style cards by integrating user feedback. Return only the updated style card, no commentary.');

	if (!result || result.length < 100) return null;

	// Clean any markdown wrapping the AI might add
	return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '').trim();
}

export { MODELS };
