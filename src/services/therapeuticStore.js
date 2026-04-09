// DEPRECATED: Therapeutic notes are now stored in the unified `memories` table.
// This file is kept as a stub to prevent import errors from any stale references.
// All therapeutic CRUD operations should use memoryStore.js instead.
//
// The therapeutic_notes table was dropped in favour of Option A (unified memories table).
// Categories like pattern, schema, avoidance, homework, session, trigger, growth
// are stored as regular memory categories with higher importance_score.

import * as memoryStore from './memoryStore';

export async function saveNote(env, chatId, type, content, tags = []) {
	// Redirect to unified memories table with importance 2 (therapeutic default)
	const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
	await memoryStore.saveMemory(env, chatId, type, content + tagSuffix, 2);
}

export async function getNotes(env, chatId, type = null, limit = 30) {
	if (type) {
		return await memoryStore.getMemoriesByCategory(env, chatId, type, limit);
	}
	const all = await memoryStore.getMemories(env, chatId, limit);
	const therapeuticCategories = ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"];
	return all.filter(m => therapeuticCategories.includes(m.category));
}

export async function deleteAllNotes(env, chatId) {
	const therapeuticCategories = ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"];
	for (const cat of therapeuticCategories) {
		await memoryStore.deleteMemoriesByCategory(env, chatId, cat);
	}
}
