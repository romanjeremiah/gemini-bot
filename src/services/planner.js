/**
 * Planning Module — CoALA Phase 2: Explicit Planning Step
 *
 * Before responding to complex or emotional messages, Xaridotis
 * explicitly plans its approach by considering:
 * 1. What is the user's current state?
 * 2. What has worked/not worked in similar past episodes?
 * 3. Which tools should be used?
 * 4. What therapeutic approach fits best?
 *
 * The plan is injected into the system prompt as a "thinking" prefix
 * that guides the response generation.
 */

import { generateShortResponse } from '../lib/ai/gemini';
import * as episodeStore from './episodeStore';

/**
 * Generate an action plan for how to respond to a message.
 * Only called for emotional/complex messages (not casual chat).
 *
 * Returns a brief plan string that gets prepended to the dynamic context.
 */
export async function generatePlan(env, chatId, userText, currentMood) {
	try {
		// Get procedural insights (what worked/didn't)
		const insights = await episodeStore.getProceduralInsights(env, chatId);
		const proceduralCtx = episodeStore.formatProceduralContext(insights);

		// Get recent episodes for pattern recognition
		const recentEps = await episodeStore.getRecentEpisodes(env, chatId, 5);
		const episodeCtx = episodeStore.formatEpisodesForContext(recentEps, 800);

		// Get any pending follow-ups
		const pending = await episodeStore.getPendingEpisodes(env, chatId, 3);
		const pendingCtx = pending.length
			? `PENDING FOLLOW-UPS (check if these resolved):\n${pending.map(p =>
				`- [${p.episode_type}] ${p.trigger_context?.slice(0, 60)} (intervention: ${p.intervention?.slice(0, 60)})`
			).join('\n')}`
			: '';

		const planPrompt = `You are planning how to respond to this message. Think step by step.

USER MESSAGE: "${userText.slice(0, 300)}"
CURRENT MOOD: ${currentMood ?? 'unknown'}

${proceduralCtx}
${episodeCtx}
${pendingCtx}

Create a brief action plan (3-5 bullet points):
1. What is the user's likely emotional state right now?
2. Are there any pending episodes to follow up on?
3. Based on procedural memory, which approach should you use? Which should you avoid?
4. Should you use any tools (save_episode, set_reminder, log_mood_entry)?
5. What is your opening move? (acknowledge, ask, suggest, just listen?)

Respond with ONLY the plan, no preamble. Keep it under 200 words.`;

		const plan = await generateShortResponse(
			planPrompt,
			'You are a clinical planning module. Be concise and actionable.',
			env
		);

		return plan || null;
	} catch (e) {
		console.error('Planning step error:', e.message);
		return null; // Planning is best-effort, never block the response
	}
}
