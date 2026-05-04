// All reminder operations keyed by user_id (owner) + chat_id (delivery target).

// Normalise reminder text for dedup comparison: strip HTML tags, collapse
// whitespace, lowercase. We don't want "<b>Morning Affirmations</b>" and
// "Morning Affirmations" to escape dedup just because of formatting.
function normaliseForDedup(text) {
	return String(text || '')
		.replace(/<[^>]+>/g, '')        // strip HTML tags
		.replace(/[\u2728\u{1F300}-\u{1F9FF}]/gu, '') // strip emojis (rough range)
		.replace(/\s+/g, ' ')           // collapse whitespace
		.trim()
		.toLowerCase()
		.slice(0, 80);                  // first 80 chars is enough signal
}

/**
 * Find an existing pending reminder that's a likely duplicate of the one
 * being saved. Returns the existing row if found, null otherwise.
 *
 * Dedup logic:
 *   - For recurring reminders (daily/weekly/monthly): same recurrence_type,
 *     same time-of-day within ±5 minutes, AND matching normalised text prefix.
 *     Time-of-day is computed as due_at modulo 86400 (seconds in a day).
 *   - For one-off reminders: due_at within ±5 minutes AND matching normalised
 *     text prefix.
 *
 * Why text-prefix matching: the model often regenerates reminders with the
 * same intent but slight wording differences ("You're going to wake up..." vs
 * "I'm going to wake up..."). The first 80 chars of normalised text catches
 * the genuine duplicates without false-positives on legitimately-different
 * reminders that happen to share a time slot.
 */
async function findDuplicateReminder(env, { userId, text, dueAt, recurrence }) {
	const targetNorm = normaliseForDedup(text);
	if (!targetNorm) return null; // empty text, can't compare

	const windowSecs = 5 * 60; // ±5 minutes

	let candidates;
	if (recurrence && recurrence !== 'none') {
		// Recurring: match on time-of-day (due_at modulo 86400) within ±5min.
		const targetTimeOfDay = ((dueAt % 86400) + 86400) % 86400;
		const { results } = await env.DB.prepare(
			`SELECT id, text, due_at, recurrence_type FROM reminders
			 WHERE user_id = ? AND status = 'pending' AND recurrence_type = ?`
		).bind(userId, recurrence).all();
		candidates = (results || []).filter(r => {
			const rTimeOfDay = ((r.due_at % 86400) + 86400) % 86400;
			const diff = Math.abs(rTimeOfDay - targetTimeOfDay);
			// Handle wrap-around (e.g. 23:58 vs 00:02)
			return diff <= windowSecs || diff >= (86400 - windowSecs);
		});
	} else {
		// One-off: match on absolute due_at within ±5min.
		const { results } = await env.DB.prepare(
			`SELECT id, text, due_at, recurrence_type FROM reminders
			 WHERE user_id = ? AND status = 'pending'
			   AND (recurrence_type IS NULL OR recurrence_type = 'none')
			   AND due_at BETWEEN ? AND ?`
		).bind(userId, dueAt - windowSecs, dueAt + windowSecs).all();
		candidates = results || [];
	}

	for (const c of candidates) {
		if (normaliseForDedup(c.text) === targetNorm) return c;
	}
	return null;
}

export async function saveReminder(env, { userId, chatId, threadId, text, dueAt, messageId, recurrence, context }) {
	// Dedup guard: refuse near-duplicates so the model can't accidentally create
	// pairs like the affirmations incident (4 reminders saved across 2 turns when
	// the model rewrote the same content). Returns the existing row id so the
	// caller can surface a useful error to the model rather than silently failing.
	const existing = await findDuplicateReminder(env, { userId, text, dueAt, recurrence });
	if (existing) {
		return { duplicate: true, existing_id: existing.id, existing_due_at: existing.due_at };
	}

	await env.DB.prepare(
		`INSERT INTO reminders
		(user_id, chat_id, text, due_at, original_message_id, recurrence_type, thread_id, status, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
	).bind(
		userId, chatId, text, dueAt, messageId,
		recurrence, threadId, JSON.stringify(context || {})
	).run();
	return { duplicate: false };
}

export async function getDueReminders(env) {
	const now = Math.floor(Date.now() / 1000);
	const { results } = await env.DB.prepare(
		"SELECT * FROM reminders WHERE due_at <= ? AND status = 'pending'"
	).bind(now).all();
	return (results || []).map(r => {
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
		"SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY due_at ASC"
	).bind(userId).all();
	return results || [];
}

/**
 * Fetch a single reminder by id, scoped by user_id so callers can't accidentally
 * (or maliciously) read another user's row. Returns the row or null.
 */
export async function getReminderForUser(env, userId, id) {
	const row = await env.DB.prepare(
		`SELECT * FROM reminders WHERE id = ? AND user_id = ? LIMIT 1`
	).bind(id, userId).first();
	return row || null;
}

/**
 * Update an existing reminder. All fields except {userId, id} are optional;
 * pass only the fields you want to change. Special `cancel: true` flag deletes
 * the row entirely (semantically: "the user cancelled this reminder").
 *
 * Identity rules:
 *   - id is required and must belong to userId. Returns {ok:false, reason:'not_found'}
 *     if no matching row exists, {ok:false, reason:'permission_denied'} if the row
 *     exists but belongs to another user. Both shapes are handled by getReminderForUser
 *     which scopes by userId — missing row could be either case but we don't leak that.
 *   - Skips dedup check entirely. Updates are explicit user actions; the user said
 *     "change THIS reminder" so we don't second-guess them. Inserts go through dedup,
 *     updates do not.
 *
 * Returns {ok: true, action: 'updated'|'cancelled', reminder: <row>} on success.
 * The returned reminder is the post-update state for cancel returns the pre-delete row.
 */
export async function updateReminder(env, { userId, id, newText, newDueAt, newRecurrence, newContext, cancel }) {
	const existing = await getReminderForUser(env, userId, id);
	if (!existing) {
		return { ok: false, reason: 'not_found' };
	}

	// Cancel path: delete the row outright. Returns the pre-delete row so the
	// caller can confirm what was removed.
	if (cancel) {
		await env.DB.prepare(`DELETE FROM reminders WHERE id = ? AND user_id = ?`)
			.bind(id, userId).run();
		return { ok: true, action: 'cancelled', reminder: existing };
	}

	// Build the SET clause from only the fields actually provided. We intentionally
	// don't allow blanking out fields with empty strings — if a caller passes
	// undefined/null, the field is left alone.
	const updates = [];
	const params = [];

	if (typeof newText === 'string' && newText.trim().length > 0) {
		updates.push('text = ?');
		params.push(newText);
	}
	if (typeof newDueAt === 'number' && Number.isFinite(newDueAt) && newDueAt > 0) {
		updates.push('due_at = ?');
		params.push(newDueAt);
	}
	if (typeof newRecurrence === 'string' && ['none', 'daily', 'weekly', 'monthly'].includes(newRecurrence)) {
		updates.push('recurrence_type = ?');
		params.push(newRecurrence);
	}
	if (typeof newContext === 'string' && newContext.trim().length > 0) {
		// Merge context into existing metadata rather than overwriting other fields
		// (firstName, persona, originalRequest, createdAt). Only `reason` changes.
		let meta = {};
		try { meta = JSON.parse(existing.metadata || '{}'); } catch { /* meta stays empty */ }
		meta.reason = newContext;
		updates.push('metadata = ?');
		params.push(JSON.stringify(meta));
	}

	if (updates.length === 0) {
		// Nothing to update — caller likely passed all-null fields. Treat as no-op
		// rather than error so the model can recover gracefully.
		return { ok: true, action: 'noop', reminder: existing };
	}

	updates.push('updated_at = CURRENT_TIMESTAMP');
	params.push(id, userId); // for the WHERE clause

	await env.DB.prepare(
		`UPDATE reminders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
	).bind(...params).run();

	// Re-read so the caller gets the post-update state (including updated_at).
	const updated = await getReminderForUser(env, userId, id);
	return { ok: true, action: 'updated', reminder: updated };
}
