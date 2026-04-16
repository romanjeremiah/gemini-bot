/**
 * Mood Journal Store
 * All operations keyed by user_id (Telegram from.id).
 * Columns mood_label and context_summary removed (Eukara schema).
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

export async function upsertEntry(env, userId, date, entryType, data) {
	const existing = await getEntry(env, userId, date, entryType);

	if (existing) {
		const merged = { ...existing, ...filterNulls(data), updated_at: new Date().toISOString() };
		await env.DB.prepare(`
			UPDATE mood_journal SET
				mood_score = ?, emotions = ?, sleep_hours = ?, sleep_quality = ?,
				medication_taken = ?, medication_time = ?, medication_notes = ?,
				activities = ?, note = ?, photo_r2_key = ?, ai_observation = ?,
				clinical_tags = ?, updated_at = ?
			WHERE id = ?
		`).bind(
			merged.mood_score ?? null,
			merged.emotions ?? null, merged.sleep_hours ?? null, merged.sleep_quality ?? null,
			merged.medication_taken ?? 0, merged.medication_time ?? null, merged.medication_notes ?? null,
			merged.activities ?? null, merged.note ?? null, merged.photo_r2_key ?? null,
			merged.ai_observation ?? null, merged.clinical_tags ?? null,
			merged.updated_at, existing.id
		).run();
		return { ...merged, id: existing.id, mood_label: merged.mood_score != null ? getMoodLabel(merged.mood_score) : null };
	}

	// Insert new
	const result = await env.DB.prepare(`
		INSERT INTO mood_journal (user_id, date, entry_type, mood_score, emotions,
			sleep_hours, sleep_quality, medication_taken, medication_time, medication_notes,
			activities, note, photo_r2_key, ai_observation, clinical_tags)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		userId, date, entryType,
		data.mood_score ?? null, data.emotions ?? null,
		data.sleep_hours ?? null, data.sleep_quality ?? null,
		data.medication_taken ?? 0, data.medication_time ?? null, data.medication_notes ?? null,
		data.activities ?? null, data.note ?? null, data.photo_r2_key ?? null,
		data.ai_observation ?? null, data.clinical_tags ?? null
	).run();
	const moodLabel = data.mood_score != null ? getMoodLabel(data.mood_score) : null;
	return { id: result?.meta?.last_row_id, user_id: userId, date, entry_type: entryType, ...data, mood_label: moodLabel };
}

export async function getEntry(env, userId, date, entryType) {
	const { results } = await env.DB.prepare(
		'SELECT * FROM mood_journal WHERE user_id = ? AND date = ? AND entry_type = ? LIMIT 1'
	).bind(userId, date, entryType).all();
	return results?.[0] || null;
}

export async function getDayEntries(env, userId, date) {
	const { results } = await env.DB.prepare(
		'SELECT * FROM mood_journal WHERE user_id = ? AND date = ? ORDER BY created_at ASC'
	).bind(userId, date).all();
	return results || [];
}

export async function getHistory(env, userId, days = 14, entryType = null) {
	const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
	let query = 'SELECT * FROM mood_journal WHERE user_id = ? AND date >= ?';
	const params = [userId, since];
	if (entryType) { query += ' AND entry_type = ?'; params.push(entryType); }
	query += ' ORDER BY date DESC, created_at DESC LIMIT 100';
	const { results } = await env.DB.prepare(query).bind(...params).all();
	return results || [];
}

export async function hasCheckedInToday(env, userId, entryType) {
	const today = todayLondon();
	const entry = await getEntry(env, userId, today, entryType);
	return !!entry;
}

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

export async function getWeeklySummary(env, userId) {
	const { results } = await env.DB.prepare(`
		SELECT date, entry_type, mood_score, emotions, sleep_hours, sleep_quality,
			medication_taken, medication_notes, activities, note, ai_observation
		FROM mood_journal
		WHERE user_id = ? AND date > date('now', '-7 days')
		ORDER BY date ASC, created_at ASC
	`).bind(userId).all();
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
