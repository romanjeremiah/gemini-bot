// All memory operations keyed by user_id (Telegram from.id), not chat_id.
// Each user has their own isolated memory space.

import * as vectorStore from './vectorStore';

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework'];

export async function saveMemory(env, userId, category, fact, importance = 1) {
	// Ensure user_profiles entry exists (prevents FK constraint errors)
	await env.DB.prepare(
		'INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)'
	).bind(userId).run();

	const result = await env.DB.prepare(
		'INSERT INTO memories (user_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
	).bind(userId, category.toLowerCase(), fact, importance).run();

	// Index in Vectorize for semantic search (fire-and-forget)
	const memoryId = result?.meta?.last_row_id || Date.now();
	vectorStore.indexMemory(env, userId, category.toLowerCase(), fact, memoryId)
		.catch(e => console.error('Vectorize memory index error:', e.message));
}

export async function getMemories(env, userId, limit = 30) {
	const { results } = await env.DB.prepare(
		'SELECT id, category, fact, importance_score, created_at FROM memories WHERE user_id = ? ORDER BY importance_score DESC, created_at DESC LIMIT ?'
	).bind(userId, limit).all();
	return results || [];
}

export async function getMemoriesByCategory(env, userId, category, limit = 10) {
	const { results } = await env.DB.prepare(
		'SELECT id, category, fact, importance_score, created_at FROM memories WHERE user_id = ? AND category = ? ORDER BY created_at DESC LIMIT ?'
	).bind(userId, category.toLowerCase(), limit).all();
	return results || [];
}

export async function getFormattedContext(env, userId) {
	const all = await getMemories(env, userId, 40);
	if (!all.length) return '- No facts saved yet.';

	const therapeutic = [], factual = [], learned = [], feedback = [], triples = [];

	for (const m of all) {
		if (THERAPEUTIC_CATEGORIES.includes(m.category)) therapeutic.push(m);
		else if (m.category === 'triple') triples.push(m);
		else if (m.category === 'discovery' || m.category === 'growth') learned.push(m);
		else if (m.category === 'feedback') feedback.push(m);
		else factual.push(m);
	}

	let ctx = '';
	if (factual.length) {
		ctx += 'Facts about the user:\n';
		for (const m of factual) ctx += `- [${m.category}] ${m.fact}\n`;
	}
	if (therapeutic.length) {
		ctx += '\nTherapeutic observations:\n';
		for (const m of therapeutic) {
			const age = getRelativeAge(m.created_at);
			ctx += `- [${m.category}] ${m.fact} (${age})\n`;
		}
	}
	if (learned.length) {
		ctx += '\nYour recent independent learning:\n';
		for (const m of learned.slice(0, 8)) ctx += `- ${m.fact}\n`;
	}
	if (feedback.length) {
		ctx += '\nLearned communication preferences (adapt your response style accordingly — these are patterns you have learned about how this user prefers you to communicate):\n';
		for (const m of feedback.slice(0, 8)) ctx += `- ${m.fact}\n`;
	}
	if (triples.length) {
		ctx += '\nKnowledge Graph (relational connections):\n';
		for (const m of triples.slice(0, 15)) ctx += `- ${m.fact}\n`;
	}
	return ctx || '- No facts saved yet.';
}

function getRelativeAge(dateStr) {
	const created = new Date(dateStr + 'Z');
	const now = new Date();
	const days = Math.floor((now - created) / 86400000);
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

export async function deleteAllMemories(env, userId) {
	await env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId).run();
}

export async function deleteMemoriesByCategory(env, userId, category) {
	await env.DB.prepare('DELETE FROM memories WHERE user_id = ? AND category = ?').bind(userId, category.toLowerCase()).run();
}

export async function getRecentTherapeuticMemories(env, userId, days = 7) {
	const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
	const { results } = await env.DB.prepare(`
		SELECT category, fact, importance_score, created_at
		FROM memories
		WHERE user_id = ?
		  AND category IN ('homework', 'coping', 'growth', 'idea', 'brain_dump', 'insight')
		  AND created_at > ?
		ORDER BY created_at DESC
		LIMIT 30
	`).bind(userId, since).all();
	return results || [];
}

export async function consolidateMemories(env, userId) {
	const allMemories = await getMemories(env, userId, 200);
	if (allMemories.length < 15) return;

	const { generateWithFallback } = await import('../lib/ai/gemini.js');
	const rawText = allMemories.map(m => `[${m.category}] ${m.fact} (Score: ${m.importance_score})`).join('\n');

	const prompt = `You are performing memory consolidation for a therapeutic Second Brain.
Here are the user's saved memories:
${rawText}

Task:
1. Remove duplicate facts entirely.
2. Merge outdated preferences with newer ones (keep the latest).
3. Group related therapeutic schemas, triggers, or patterns into coherent summaries.
4. Preserve the exact wording of critical triggers or schemas (importance 3).
5. Keep all unique facts, ideas, and brain dumps.

Return ONLY a raw JSON array:
[{"category":"preference","fact":"...","importance":1}]
No markdown, no backticks. Just the array.`;

	try {
		const { text } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: prompt }] }],
			{ temperature: 0.2 }
		);
		const arrayMatch = text.match(/\[[\s\S]*\]/);
		const cleaned = arrayMatch ? arrayMatch[0] : '[]';
		const consolidated = JSON.parse(cleaned);
		if (!Array.isArray(consolidated) || consolidated.length === 0) return;

		const deleteStmt = env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId);
		const insertStmts = consolidated.map(m =>
			env.DB.prepare(
				'INSERT INTO memories (user_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
			).bind(userId, (m.category || 'general').toLowerCase(), m.fact, m.importance || 1)
		);
		await env.DB.batch([deleteStmt, ...insertStmts]);
		console.log(`🧠 Consolidated ${allMemories.length} → ${consolidated.length} memories (batched)`);
		await env.DB.exec('PRAGMA optimize;');
	} catch (e) {
		console.error('Memory consolidation failed:', e.message);
	}
}
