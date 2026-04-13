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
 */

const MODELS = {
	tiny: '@cf/meta/llama-3.2-1b-instruct',        // Cheapest: sentiment, tagging
	balanced: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', // Mid: triples, observations
	context: '@cf/zai-org/glm-4.7-flash',           // 131K context: summarisation
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

		const result = await env.AI.run(model, { messages, max_tokens: 512 });
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

	const memoryList = memories.map((m, i) => `[${i}] [${m.category}] ${m.fact}`).join('\n');

	const result = await cfAiGenerate(env, MODELS.context,
		`Here are ${memories.length} stored memories. Identify:
1. DUPLICATES: memories that say the same thing (list pairs of indices)
2. GROUPS: memories that relate to the same topic (list groups of indices with a label)

MEMORIES:
${memoryList}

Respond in this exact format:
DUPLICATES: [0,5], [3,7]
GROUP: ADHD management: [1,4,8,12]
GROUP: Coffee preferences: [2,9]
GROUP: Work patterns: [3,6,11]

If no duplicates found, write: DUPLICATES: none`,
		'You are a data organiser. Be precise with indices. Only group genuinely related items.'
	);

	// Parse the response
	const duplicates = [];
	const groups = [];

	if (result) {
		const dupMatch = result.match(/DUPLICATES:\s*(.+)/);
		if (dupMatch && !dupMatch[1].includes('none')) {
			const pairs = dupMatch[1].matchAll(/\[(\d+),\s*(\d+)\]/g);
			for (const p of pairs) duplicates.push([parseInt(p[1]), parseInt(p[2])]);
		}

		const groupMatches = result.matchAll(/GROUP:\s*(.+?):\s*\[([^\]]+)\]/g);
		for (const g of groupMatches) {
			const indices = g[2].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
			groups.push({ label: g[1].trim(), indices });
		}
	}

	return { groups, duplicates };
}

export { MODELS };
