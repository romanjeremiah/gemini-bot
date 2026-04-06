export async function saveMemory(env, chatId, category, fact) {
	await env.DB.prepare(
		"INSERT INTO memories (chat_id, category, fact) VALUES (?, ?, ?)"
	).bind(chatId, category, fact).run();
}

export async function getMemories(env, chatId, limit = 20) {
	const { results } = await env.DB.prepare(
		"SELECT category, fact, created_at FROM memories WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
	).bind(chatId, limit).all();
	return results || [];
}

export async function deleteAllMemories(env, chatId) {
	await env.DB.prepare("DELETE FROM memories WHERE chat_id = ?").bind(chatId).run();
}
