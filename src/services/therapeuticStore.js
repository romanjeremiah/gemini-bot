export async function saveNote(env, chatId, type, content, tags = []) {
	await env.DB.prepare(
		"INSERT INTO therapeutic_notes (chat_id, note_type, content, tags, created_at) VALUES (?, ?, ?, ?, ?)"
	).bind(chatId, type, content, JSON.stringify(tags), new Date().toISOString()).run();
}

export async function getNotes(env, chatId, type = null, limit = 30) {
	let query, params;
	if (type) {
		query = "SELECT id, note_type, content, tags, created_at FROM therapeutic_notes WHERE chat_id = ? AND note_type = ? ORDER BY created_at DESC LIMIT ?";
		params = [chatId, type, limit];
	} else {
		query = "SELECT id, note_type, content, tags, created_at FROM therapeutic_notes WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?";
		params = [chatId, limit];
	}
	const { results } = await env.DB.prepare(query).bind(...params).all();
	return (results || []).map(r => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
}

export async function deleteAllNotes(env, chatId) {
	await env.DB.prepare("DELETE FROM therapeutic_notes WHERE chat_id = ?").bind(chatId).run();
}
