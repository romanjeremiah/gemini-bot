// ---- Categories guide (for reference, not enforced in DB) ----
// Factual: preference, personal, work, hobby, identity, relationship
// Therapeutic: pattern, trigger, avoidance, schema, growth, coping, insight, homework
// Second Brain: idea, brain_dump
// Research: discovery (auto-populated by weekly curiosity digest)
// Feedback: feedback (reaction-based RLHF from user emoji reactions)
// Health: health, habit, medication, sleep, energy
// All categories live in the same table — therapeutic ones are distinguished
// by category name and higher importance_score

import * as vectorStore from './vectorStore';

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework'];

export async function saveMemory(env, chatId, category, fact, importance = 1) {
	const result = await env.DB.prepare(
		"INSERT INTO memories (chat_id, category, fact, importance_score) VALUES (?, ?, ?, ?)"
	).bind(chatId, category.toLowerCase(), fact, importance).run();
	// Also index in Vectorize for semantic search (fire-and-forget)
	const memoryId = result?.meta?.last_row_id || Date.now();
	vectorStore.indexMemory(env, chatId, category.toLowerCase(), fact, memoryId)
		.catch(e => console.error('Vectorize memory index error:', e.message));
}

export async function getMemories(env, chatId, limit = 30) {
	const { results } = await env.DB.prepare(
		"SELECT id, category, fact, importance_score, created_at FROM memories WHERE chat_id = ? ORDER BY importance_score DESC, created_at DESC LIMIT ?"
	).bind(chatId, limit).all();
	return results || [];
}

export async function getMemoriesByCategory(env, chatId, category, limit = 10) {
	const { results } = await env.DB.prepare(
		"SELECT id, category, fact, importance_score, created_at FROM memories WHERE chat_id = ? AND category = ? ORDER BY created_at DESC LIMIT ?"
	).bind(chatId, category.toLowerCase(), limit).all();
	return results || [];
}

// Returns memories grouped and formatted for the system prompt
// High-importance and therapeutic memories are surfaced prominently
export async function getFormattedContext(env, chatId) {
	const all = await getMemories(env, chatId, 40);
	if (!all.length) return "- No facts saved yet.";

	const therapeutic = [];
	const factual = [];
	const learned = [];
	const feedback = [];
	const triples = [];

	for (const m of all) {
		if (THERAPEUTIC_CATEGORIES.includes(m.category)) {
			therapeutic.push(m);
		} else if (m.category === 'triple') {
			triples.push(m);
		} else if (m.category === 'discovery' || m.category === 'growth') {
			learned.push(m);
		} else if (m.category === 'feedback') {
			feedback.push(m);
		} else {
			factual.push(m);
		}
	}

	let ctx = "";

	if (factual.length) {
		ctx += "Facts about the user:\n";
		for (const m of factual) ctx += `- [${m.category}] ${m.fact}\n`;
	}

	if (therapeutic.length) {
		ctx += "\nTherapeutic observations:\n";
		for (const m of therapeutic) {
			const age = getRelativeAge(m.created_at);
			ctx += `- [${m.category}] ${m.fact} (${age})\n`;
		}
	}

	if (learned.length) {
		ctx += "\nYour recent independent learning (things you studied or discovered on your own):\n";
		for (const m of learned.slice(0, 8)) ctx += `- ${m.fact}\n`;
	}

	if (feedback.length) {
		ctx += "\nUser reaction feedback (how the user responded to your messages):\n";
		for (const m of feedback.slice(0, 5)) ctx += `- ${m.fact}\n`;
	}

	if (triples.length) {
		ctx += "\nKnowledge Graph (relational connections you have learned):\n";
		for (const m of triples.slice(0, 15)) ctx += `- ${m.fact}\n`;
	}

	return ctx || "- No facts saved yet.";
}

function getRelativeAge(dateStr) {
	const created = new Date(dateStr + "Z");
	const now = new Date();
	const days = Math.floor((now - created) / 86400000);
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

export async function deleteAllMemories(env, chatId) {
	await env.DB.prepare("DELETE FROM memories WHERE chat_id = ?").bind(chatId).run();
}

export async function deleteMemoriesByCategory(env, chatId, category) {
	await env.DB.prepare("DELETE FROM memories WHERE chat_id = ? AND category = ?").bind(chatId, category.toLowerCase()).run();
}


/**
 * Fetch recent therapeutic homework, coping strategies, growth notes, ideas, and brain dumps.
 */
export async function getRecentTherapeuticMemories(env, chatId, days = 7) {
	const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
	const { results } = await env.DB.prepare(`
		SELECT category, fact, importance_score, created_at
		FROM memories
		WHERE chat_id = ?
		  AND category IN ('homework', 'coping', 'growth', 'idea', 'brain_dump', 'insight')
		  AND created_at > ?
		ORDER BY created_at DESC
		LIMIT 30
	`).bind(chatId, since).all();
	return results || [];
}


/**
 * REM Sleep Cycle: Consolidate, deduplicate, and merge outdated memories.
 * Runs monthly. Feeds all memories to Gemini Pro for intelligent compression.
 */
export async function consolidateMemories(env, chatId) {
	const allMemories = await getMemories(env, chatId, 200);
	if (allMemories.length < 15) return; // Not enough to need consolidation

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
		// Safely extract JSON array even if Gemini adds introductory text
		const arrayMatch = text.match(/\[[\s\S]*\]/);
		const cleaned = arrayMatch ? arrayMatch[0] : '[]';
		const consolidated = JSON.parse(cleaned);

		if (!Array.isArray(consolidated) || consolidated.length === 0) return;

		// Batch write: delete all then insert consolidated in a single atomic transaction
		const deleteStmt = env.DB.prepare("DELETE FROM memories WHERE chat_id = ?").bind(chatId);
		const insertStmts = consolidated.map(m =>
			env.DB.prepare(
				"INSERT INTO memories (chat_id, category, fact, importance_score) VALUES (?, ?, ?, ?)"
			).bind(chatId, (m.category || 'general').toLowerCase(), m.fact, m.importance || 1)
		);
		await env.DB.batch([deleteStmt, ...insertStmts]);

		console.log(`🧠 Consolidated ${allMemories.length} → ${consolidated.length} memories (batched)`);

		// Optimise D1 indexes after bulk write (recommended by Cloudflare)
		await env.DB.exec('PRAGMA optimize;');
	} catch (e) {
		console.error('Memory consolidation failed:', e.message);
	}
}
