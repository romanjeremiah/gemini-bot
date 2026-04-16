/**
 * Episode Store — CoALA Episodic Memory
 * All data keyed by user_id (Telegram from.id) for per-user isolation.
 */

export async function saveEpisode(env, userId, episode) {
	const {
		type = 'conversation', trigger = null, emotions = [],
		intervention = null, outcome = null, lesson = null,
		moodScore = null, relatedMemoryIds = [], metadata = {}
	} = episode;

	await env.DB.prepare(`
		INSERT INTO episodes (user_id, episode_type, trigger_context, emotions, intervention, outcome, lesson, mood_score, related_memory_ids, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		userId, type, trigger, JSON.stringify(emotions), intervention,
		outcome, lesson, moodScore, JSON.stringify(relatedMemoryIds),
		JSON.stringify(metadata)
	).run();
}

export async function getRecentEpisodes(env, userId, limit = 10, type = null) {
	let query = 'SELECT * FROM episodes WHERE user_id = ?';
	const params = [userId];
	if (type) { query += ' AND episode_type = ?'; params.push(type); }
	query += ' ORDER BY created_at DESC LIMIT ?';
	params.push(limit);
	const { results } = await env.DB.prepare(query).bind(...params).all();
	return (results || []).map(parseEpisode);
}

export async function searchEpisodes(env, userId, keyword, limit = 5) {
	const { safeLike } = await import('../lib/db');
	const safe = safeLike(keyword);
	if (!safe) return [];
	const p = `%${safe}%`;
	const { results } = await env.DB.prepare(`
		SELECT * FROM episodes WHERE user_id = ?
		AND (trigger_context LIKE ? OR intervention LIKE ? OR lesson LIKE ? OR emotions LIKE ?)
		ORDER BY created_at DESC LIMIT ?
	`).bind(userId, p, p, p, p, limit).all();
	return (results || []).map(parseEpisode);
}

export async function getEpisodesByEmotion(env, userId, emotions, limit = 5) {
	const emotionList = Array.isArray(emotions) ? emotions : [emotions];
	const conditions = emotionList.map(() => 'emotions LIKE ?').join(' OR ');
	const params = [userId, ...emotionList.map(e => `%${e}%`), limit];
	const { results } = await env.DB.prepare(`
		SELECT * FROM episodes WHERE user_id = ? AND (${conditions})
		ORDER BY created_at DESC LIMIT ?
	`).bind(...params).all();
	return (results || []).map(parseEpisode);
}

// Security: filter by BOTH user_id AND id to prevent cross-user modification
export async function updateEpisodeOutcome(env, userId, episodeId, outcome, lesson) {
	await env.DB.prepare(
		'UPDATE episodes SET outcome = ?, lesson = ? WHERE id = ? AND user_id = ?'
	).bind(outcome, lesson, episodeId, userId).run();
}

export async function getPendingEpisodes(env, userId, limit = 5) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM episodes WHERE user_id = ? AND outcome = 'pending' ORDER BY created_at DESC LIMIT ?"
	).bind(userId, limit).all();
	return (results || []).map(parseEpisode);
}

export async function getProceduralInsights(env, userId) {
	const { results: positive } = await env.DB.prepare(`
		SELECT intervention, lesson, emotions, episode_type FROM episodes
		WHERE user_id = ? AND outcome = 'positive' AND intervention IS NOT NULL
		ORDER BY created_at DESC LIMIT 10
	`).bind(userId).all();

	const { results: negative } = await env.DB.prepare(`
		SELECT intervention, lesson, emotions, episode_type FROM episodes
		WHERE user_id = ? AND outcome = 'negative' AND intervention IS NOT NULL
		ORDER BY created_at DESC LIMIT 10
	`).bind(userId).all();

	const mapRow = (r) => ({
		intervention: r.intervention, lesson: r.lesson,
		emotions: safeJsonParse(r.emotions, []), type: r.episode_type,
	});
	return {
		worked: (positive || []).map(mapRow),
		didntWork: (negative || []).map(mapRow),
	};
}

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

export function formatProceduralContext(insights) {
	if (!insights.worked.length && !insights.didntWork.length) return '';
	let ctx = 'PROCEDURAL MEMORY (learned from past experience):\n';
	if (insights.worked.length) {
		ctx += 'What has WORKED:\n';
		insights.worked.forEach(w => { ctx += `- ${w.intervention} -> ${w.lesson || 'positive outcome'}\n`; });
	}
	if (insights.didntWork.length) {
		ctx += 'What has NOT WORKED:\n';
		insights.didntWork.forEach(w => { ctx += `- ${w.intervention} -> ${w.lesson || 'negative outcome'}\n`; });
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
