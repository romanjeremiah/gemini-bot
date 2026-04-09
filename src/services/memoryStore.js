// ---- Categories guide (for reference, not enforced in DB) ----
// Factual: preference, personal, work, hobby, identity, relationship
// Therapeutic: pattern, trigger, avoidance, schema, growth, coping, insight
// Health: health, habit, medication, sleep, energy
// All categories live in the same table — therapeutic ones are distinguished
// by category name and higher importance_score

import * as vectorStore from './vectorStore';

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight'];

export async function saveMemory(env, chatId, category, fact, importance = 1, userId = null) {
	const result = await env.DB.prepare(
		"INSERT INTO memories (chat_id, category, fact, importance_score, user_id) VALUES (?, ?, ?, ?, ?)"
	).bind(chatId, category.toLowerCase(), fact, importance, userId).run();
	// Also index in Vectorize for semantic search (fire-and-forget)
	const memoryId = result?.meta?.last_row_id || Date.now();
	vectorStore.indexMemory(env, chatId, category.toLowerCase(), fact, memoryId)
		.catch(e => console.error('Vectorize memory index error:', e.message));
}

export async function getMemories(env, chatId, limit = 30) {
	const { results } = await env.DB.prepare(
		"SELECT category, fact, importance_score, created_at FROM memories WHERE chat_id = ? ORDER BY importance_score DESC, created_at DESC LIMIT ?"
	).bind(chatId, limit).all();
	return results || [];
}

export async function getMemoriesByCategory(env, chatId, category, limit = 10) {
	const { results } = await env.DB.prepare(
		"SELECT category, fact, importance_score, created_at FROM memories WHERE chat_id = ? AND category = ? ORDER BY created_at DESC LIMIT ?"
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

	for (const m of all) {
		if (THERAPEUTIC_CATEGORIES.includes(m.category)) {
			therapeutic.push(m);
		} else {
			factual.push(m);
		}
	}

	let ctx = "";

	if (factual.length) {
		ctx += "Facts:\n";
		for (const m of factual) ctx += `- [${m.category}] ${m.fact}\n`;
	}

	if (therapeutic.length) {
		ctx += "\nTherapeutic observations:\n";
		for (const m of therapeutic) {
			const age = getRelativeAge(m.created_at);
			ctx += `- [${m.category}] ${m.fact} (${age})\n`;
		}
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
