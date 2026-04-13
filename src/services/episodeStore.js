/**
 * Episode Store — CoALA Episodic Memory for Xaridotis
 *
 * Records structured episodes from significant interactions:
 * - What triggered it (context)
 * - What emotions were present
 * - What intervention was tried
 * - What the outcome was
 * - What lesson was learned
 *
 * This enables Xaridotis to recall: "Last time Roma felt X,
 * we tried Y and it worked/didn't work."
 */

/**
 * Save a new episode to the database.
 */
export async function saveEpisode(env, chatId, episode) {
	const {
		type = 'conversation',
		trigger = null,
		emotions = [],
		intervention = null,
		outcome = null,
		lesson = null,
		moodScore = null,
		relatedMemoryIds = [],
		metadata = {}
	} = episode;

	await env.DB.prepare(`
		INSERT INTO episodes (chat_id, episode_type, trigger_context, emotions, intervention, outcome, lesson, mood_score, related_memory_ids, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		chatId,
		type,
		trigger,
		JSON.stringify(emotions),
		intervention,
		outcome,
		lesson,
		moodScore,
		JSON.stringify(relatedMemoryIds),
		JSON.stringify(metadata)
	).run();
}

/**
 * Get recent episodes, optionally filtered by type.
 */
export async function getRecentEpisodes(env, chatId, limit = 10, type = null) {
	let query = 'SELECT * FROM episodes WHERE chat_id = ?';
	const params = [chatId];
	if (type) {
		query += ' AND episode_type = ?';
		params.push(type);
	}
	query += ' ORDER BY created_at DESC LIMIT ?';
	params.push(limit);
	const { results } = await env.DB.prepare(query).bind(...params).all();
	return (results || []).map(parseEpisode);
}

/**
 * Search episodes by keyword in trigger, intervention, or lesson.
 */
export async function searchEpisodes(env, chatId, keyword, limit = 5) {
	const safe = keyword.replace(/[%_\\'";\n\r]/g, '').slice(0, 50);
	const { results } = await env.DB.prepare(`
		SELECT * FROM episodes WHERE chat_id = ?
		AND (trigger_context LIKE ? OR intervention LIKE ? OR lesson LIKE ? OR emotions LIKE ?)
		ORDER BY created_at DESC LIMIT ?
	`).bind(chatId, `%${safe}%`, `%${safe}%`, `%${safe}%`, `%${safe}%`, limit).all();
	return (results || []).map(parseEpisode);
}

/**
 * Get episodes related to specific emotions (for the reflection step).
 */
export async function getEpisodesByEmotion(env, chatId, emotions, limit = 5) {
	const emotionList = Array.isArray(emotions) ? emotions : [emotions];
	const conditions = emotionList.map(() => 'emotions LIKE ?').join(' OR ');
	const params = [chatId, ...emotionList.map(e => `%${e}%`), limit];
	const { results } = await env.DB.prepare(`
		SELECT * FROM episodes WHERE chat_id = ? AND (${conditions})
		ORDER BY created_at DESC LIMIT ?
	`).bind(...params).all();
	return (results || []).map(parseEpisode);
}

/**
 * Format episodes into a context string for Gemini prompts.
 */
export function formatEpisodesForContext(episodes, maxLen = 2000) {
	if (!episodes.length) return '';
	let ctx = 'PAST EPISODES (what happened before in similar situations):\n';
	for (const ep of episodes) {
		const date = new Date(ep.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
		let line = `[${date}] ${ep.episode_type}`;
		if (ep.trigger_context) line += ` | Trigger: ${ep.trigger_context.slice(0, 80)}`;
		if (ep.emotions?.length) line += ` | Emotions: ${ep.emotions.join(', ')}`;
		if (ep.intervention) line += ` | Tried: ${ep.intervention.slice(0, 80)}`;
		if (ep.outcome) line += ` | Outcome: ${ep.outcome}`;
		if (ep.lesson) line += ` | Lesson: ${ep.lesson.slice(0, 80)}`;
		ctx += line + '\n';
		if (ctx.length > maxLen) break;
	}
	return ctx;
}

function parseEpisode(row) {
	return {
		...row,
		emotions: safeJsonParse(row.emotions, []),
		related_memory_ids: safeJsonParse(row.related_memory_ids, []),
		metadata: safeJsonParse(row.metadata, {}),
	};
}

function safeJsonParse(str, fallback) {
	if (!str) return fallback;
	try { return JSON.parse(str); } catch { return fallback; }
}


/**
 * Update an episode's outcome after follow-up.
 * Used by the outcome tracking system to close the loop.
 */
export async function updateEpisodeOutcome(env, episodeId, outcome, lesson) {
	await env.DB.prepare(`
		UPDATE episodes SET outcome = ?, lesson = ? WHERE id = ?
	`).bind(outcome, lesson, episodeId).run();
}

/**
 * Get episodes with pending outcomes (outcome = 'pending').
 * Used by the follow-up system to check on unresolved episodes.
 */
export async function getPendingEpisodes(env, chatId, limit = 5) {
	const { results } = await env.DB.prepare(`
		SELECT * FROM episodes WHERE chat_id = ? AND outcome = 'pending'
		ORDER BY created_at DESC LIMIT ?
	`).bind(chatId, limit).all();
	return (results || []).map(parseEpisode);
}

/**
 * Get procedural insights: what approaches worked vs didn't.
 * Returns a summary of successful and failed interventions
 * that Xaridotis can use to adjust its behaviour.
 */
export async function getProceduralInsights(env, chatId) {
	const { results: positive } = await env.DB.prepare(`
		SELECT intervention, lesson, emotions, episode_type FROM episodes
		WHERE chat_id = ? AND outcome = 'positive' AND intervention IS NOT NULL
		ORDER BY created_at DESC LIMIT 10
	`).bind(chatId).all();

	const { results: negative } = await env.DB.prepare(`
		SELECT intervention, lesson, emotions, episode_type FROM episodes
		WHERE chat_id = ? AND outcome = 'negative' AND intervention IS NOT NULL
		ORDER BY created_at DESC LIMIT 10
	`).bind(chatId).all();

	const worked = (positive || []).map(r => ({
		intervention: r.intervention,
		lesson: r.lesson,
		emotions: safeJsonParse(r.emotions, []),
		type: r.episode_type,
	}));

	const didntWork = (negative || []).map(r => ({
		intervention: r.intervention,
		lesson: r.lesson,
		emotions: safeJsonParse(r.emotions, []),
		type: r.episode_type,
	}));

	return { worked, didntWork };
}

/**
 * Format procedural insights for injection into Gemini's context.
 */
export function formatProceduralContext(insights) {
	if (!insights.worked.length && !insights.didntWork.length) return '';
	let ctx = 'PROCEDURAL MEMORY (learned from past experience):\n';
	if (insights.worked.length) {
		ctx += 'What has WORKED:\n';
		insights.worked.forEach(w => {
			ctx += `- ${w.intervention} → ${w.lesson || 'positive outcome'}\n`;
		});
	}
	if (insights.didntWork.length) {
		ctx += 'What has NOT WORKED:\n';
		insights.didntWork.forEach(w => {
			ctx += `- ${w.intervention} → ${w.lesson || 'negative outcome'}\n`;
		});
	}
	return ctx;
}
