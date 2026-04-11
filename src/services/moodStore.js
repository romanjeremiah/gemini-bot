/**
 * Mood Journal Store
 * CRUD operations for the mood_journal table.
 * Supports partial upserts (morning logs sleep, evening adds mood score).
 */

const MOOD_LABELS = {
	0: 'severe_depression', 1: 'severe_depression',
	2: 'mild_depression', 3: 'mild_depression',
	4: 'balanced', 5: 'balanced', 6: 'balanced',
	7: 'hypomania', 8: 'hypomania',
	9: 'mania', 10: 'mania',
};

export function getMoodLabel(score) {
	return MOOD_LABELS[score] || 'unknown';
}

/**
 * Upsert a mood journal entry. Merges partial data with existing entry.
 */
export async function upsertEntry(env, chatId, date, entryType, data) {
	const existing = await getEntry(env, chatId, date, entryType);

	if (existing) {
		// Merge: only overwrite fields that are provided (non-null)
		const merged = { ...existing, ...filterNulls(data), updated_at: new Date().toISOString() };
		if (merged.mood_score !== undefined && merged.mood_score !== null) {
			merged.mood_label = getMoodLabel(merged.mood_score);
		}
		await env.DB.prepare(`
			UPDATE mood_journal SET
				mood_score = ?, mood_label = ?, emotions = ?, sleep_hours = ?, sleep_quality = ?,
				medication_taken = ?, medication_time = ?, medication_notes = ?,
				activities = ?, note = ?, photo_r2_key = ?, ai_observation = ?,
				context_summary = ?, updated_at = ?
			WHERE id = ?
		`).bind(
			merged.mood_score ?? null, merged.mood_label ?? null,
			merged.emotions ?? null, merged.sleep_hours ?? null, merged.sleep_quality ?? null,
			merged.medication_taken ?? 0, merged.medication_time ?? null, merged.medication_notes ?? null,
			merged.activities ?? null, merged.note ?? null, merged.photo_r2_key ?? null,
			merged.ai_observation ?? null, merged.context_summary ?? null,
			merged.updated_at, existing.id
		).run();
		return { ...merged, id: existing.id };
	}

	// Insert new
	const moodLabel = data.mood_score != null ? getMoodLabel(data.mood_score) : null;
	const result = await env.DB.prepare(`
		INSERT INTO mood_journal (chat_id, date, entry_type, mood_score, mood_label, emotions,
			sleep_hours, sleep_quality, medication_taken, medication_time, medication_notes,
			activities, note, photo_r2_key, ai_observation, context_summary)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		chatId, date, entryType,
		data.mood_score ?? null, moodLabel, data.emotions ?? null,
		data.sleep_hours ?? null, data.sleep_quality ?? null,
		data.medication_taken ?? 0, data.medication_time ?? null, data.medication_notes ?? null,
		data.activities ?? null, data.note ?? null, data.photo_r2_key ?? null,
		data.ai_observation ?? null, data.context_summary ?? null
	).run();
	return { id: result?.meta?.last_row_id, chat_id: chatId, date, entry_type: entryType, ...data, mood_label: moodLabel };
}

/**
 * Get a specific entry by chat_id + date + entry_type.
 */
export async function getEntry(env, chatId, date, entryType) {
	const { results } = await env.DB.prepare(
		'SELECT * FROM mood_journal WHERE chat_id = ? AND date = ? AND entry_type = ? LIMIT 1'
	).bind(chatId, date, entryType).all();
	return results?.[0] || null;
}

/**
 * Get all entries for a date (morning + midday + evening).
 */
export async function getDayEntries(env, chatId, date) {
	const { results } = await env.DB.prepare(
		'SELECT * FROM mood_journal WHERE chat_id = ? AND date = ? ORDER BY created_at ASC'
	).bind(chatId, date).all();
	return results || [];
}

/**
 * Get mood history for a date range.
 */
export async function getHistory(env, chatId, days = 14, entryType = null) {
	const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
	let query = 'SELECT * FROM mood_journal WHERE chat_id = ? AND date >= ?';
	const params = [chatId, since];
	if (entryType) { query += ' AND entry_type = ?'; params.push(entryType); }
	query += ' ORDER BY date DESC, created_at DESC LIMIT 100';
	const { results } = await env.DB.prepare(query).bind(...params).all();
	return results || [];
}

/**
 * Check if a check-in was already done today for a specific type.
 */
export async function hasCheckedInToday(env, chatId, entryType) {
	const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
	const entry = await getEntry(env, chatId, today, entryType);
	return !!entry;
}

/**
 * Get today's date string in London timezone.
 */
export function todayLondon() {
	return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function filterNulls(obj) {
	const result = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== null && v !== undefined) result[k] = v;
	}
	return result;
}


/**
 * Get the last 7 days of mood data for weekly analysis.
 */
export async function getWeeklySummary(env, chatId) {
	const { results } = await env.DB.prepare(`
		SELECT date, entry_type, mood_score, mood_label, emotions, sleep_hours, sleep_quality,
			medication_taken, medication_notes, activities, note, ai_observation
		FROM mood_journal
		WHERE chat_id = ? AND date > date('now', '-7 days')
		ORDER BY date ASC, created_at ASC
	`).bind(chatId).all();
	return (results || []).map(r => ({
		...r,
		emotions: safeParseJSON(r.emotions),
		activities: safeParseJSON(r.activities),
	}));
}

function safeParseJSON(str) {
	if (!str) return null;
	try { return JSON.parse(str); } catch { return str; }
}
