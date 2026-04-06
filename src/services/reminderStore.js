export async function saveReminder(env, { userId, chatId, threadId, text, dueAt, messageId, recurrence, context }) {
	await env.DB.prepare(
		`INSERT INTO reminders 
		(creator_chat_id, recipient_chat_id, text, due_at, original_message_id, recurrence_type, thread_id, status, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
	).bind(
		userId,       // who created it (always the individual user)
		chatId,       // where to deliver it (group or private chat)
		text,
		dueAt,
		messageId,
		recurrence,
		threadId,
		JSON.stringify(context || {})
	).run();
}

export async function getDueReminders(env) {
	const now = Math.floor(Date.now() / 1000);
	const { results } = await env.DB.prepare(
		"SELECT * FROM reminders WHERE due_at <= ? AND status = 'pending'"
	).bind(now).all();
	return (results || []).map(r => {
		// Parse metadata JSON safely
		try { r.parsedMeta = JSON.parse(r.metadata || '{}'); } 
		catch { r.parsedMeta = {}; }
		return r;
	});
}

export async function clearReminder(env, id) {
	await env.DB.prepare(
		"UPDATE reminders SET status = 'delivered', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
	).bind(id).run();
}

export async function updateRecurrence(env, id, nextTime) {
	await env.DB.prepare(
		"UPDATE reminders SET due_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
	).bind(nextTime, id).run();
}

export async function getUserReminders(env, userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM reminders WHERE creator_chat_id = ? AND status = 'pending' ORDER BY due_at ASC"
	).bind(userId).all();
	return results || [];
}
