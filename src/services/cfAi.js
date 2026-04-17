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

export { MODELS };


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
