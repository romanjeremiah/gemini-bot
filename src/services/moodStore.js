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

// Source values (added 2026-05-05). Distinguishes how a row was created so the
// scheduled evening cron can tell a real check-in from a casual mid-day mood
// mention. See hasRealEveningCheckin() below.
//   'cron_poll'       — set by the scheduled evening poll path
//   'manual_command'  — set by the /mood command
//   'inline_chat'     — set when the AI calls log_mood_entry from conversation
//   NULL              — pre-migration rows; treated as inline_chat for safety
export const MOOD_SOURCES = ['cron_poll', 'manual_command', 'inline_chat'];

export async function upsertEntry(env, userId, date, entryType, data) {
	const existing = await getEntry(env, userId, date, entryType);

	if (existing) {
		const merged = { ...existing, ...filterNulls(data), updated_at: new Date().toISOString() };
		// Source upgrade rule: cron_poll > manual_command > inline_chat. Once a
		// row is tagged as a real check-in (cron_poll or manual_command), don't
		// downgrade it back to inline_chat on a later AI-driven update.
		const keepSource = sourcePrecedence(merged.source) >= sourcePrecedence(data.source)
			? merged.source
			: data.source;
		await env.DB.prepare(`
			UPDATE mood_journal SET
				mood_score = ?, emotions = ?, sleep_hours = ?, sleep_quality = ?,
				medication_taken = ?, medication_time = ?, medication_notes = ?,
				activities = ?, note = ?, photo_r2_key = ?, ai_observation = ?,
				clinical_tags = ?, source = ?, updated_at = ?
			WHERE id = ?
		`).bind(
			merged.mood_score ?? null,
			merged.emotions ?? null, merged.sleep_hours ?? null, merged.sleep_quality ?? null,
			merged.medication_taken ?? 0, merged.medication_time ?? null, merged.medication_notes ?? null,
			merged.activities ?? null, merged.note ?? null, merged.photo_r2_key ?? null,
			merged.ai_observation ?? null, merged.clinical_tags ?? null,
			keepSource ?? null, merged.updated_at, existing.id
		).run();
		return { ...merged, source: keepSource, id: existing.id, mood_label: merged.mood_score != null ? getMoodLabel(merged.mood_score) : null };
	}

	// Insert new
	const result = await env.DB.prepare(`
		INSERT INTO mood_journal (user_id, date, entry_type, mood_score, emotions,
			sleep_hours, sleep_quality, medication_taken, medication_time, medication_notes,
			activities, note, photo_r2_key, ai_observation, clinical_tags, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		userId, date, entryType,
		data.mood_score ?? null, data.emotions ?? null,
		data.sleep_hours ?? null, data.sleep_quality ?? null,
		data.medication_taken ?? 0, data.medication_time ?? null, data.medication_notes ?? null,
		data.activities ?? null, data.note ?? null, data.photo_r2_key ?? null,
		data.ai_observation ?? null, data.clinical_tags ?? null,
		data.source ?? null
	).run();
	const moodLabel = data.mood_score != null ? getMoodLabel(data.mood_score) : null;
	return { id: result?.meta?.last_row_id, user_id: userId, date, entry_type: entryType, ...data, mood_label: moodLabel };
}

function sourcePrecedence(s) {
	if (s === 'cron_poll') return 3;
	if (s === 'manual_command') return 2;
	if (s === 'inline_chat') return 1;
	return 0; // null / unknown
}

/**
 * Did the user complete a *real* evening check-in today (not a casual mid-day
 * mood mention)? Used by cron to decide whether to skip the scheduled poll.
 *
 * Returns true if a row exists with entry_type='evening' AND source IN
 * ('cron_poll', 'manual_command'). NULL-source rows (pre-migration) are NOT
 * treated as real check-ins so the cron will still fire today and rebuild
 * the row tagged as cron_poll.
 */
export async function hasRealEveningCheckin(env, userId, date = null) {
	const d = date || todayLondon();
	const row = await env.DB.prepare(
		"SELECT id FROM mood_journal WHERE user_id = ? AND date = ? AND entry_type = 'evening' AND source IN ('cron_poll', 'manual_command') LIMIT 1"
	).bind(userId, d).first();
	return !!row;
}

/**
 * Has the user already logged sleep_hours anywhere today (any entry_type)?
 * The new evening flow uses this to decide whether to ASK about sleep —
 * if morning already captured it, evening skips the question.
 */
export async function hasSleepLoggedToday(env, userId, date = null) {
	const d = date || todayLondon();
	const row = await env.DB.prepare(
		'SELECT sleep_hours FROM mood_journal WHERE user_id = ? AND date = ? AND sleep_hours IS NOT NULL LIMIT 1'
	).bind(userId, d).first();
	return row?.sleep_hours ?? null; // returns the value if present, null if not
}

/**
 * Has the user already attached a photo to any of today's mood rows?
 * The new evening flow uses this to decide whether to ASK for a photo.
 */
export async function hasPhotoLoggedToday(env, userId, date = null) {
	const d = date || todayLondon();
	const row = await env.DB.prepare(
		'SELECT photo_r2_key FROM mood_journal WHERE user_id = ? AND date = ? AND photo_r2_key IS NOT NULL LIMIT 1'
	).bind(userId, d).first();
	return !!row;
}

/**
 * Get the union of all activities logged across all of today's rows. Returns
 * an array of canonical keys (deduped). Used by the activities keyboard to
 * filter the New-mode list (only show un-logged activities).
 */
export async function getTodayActivities(env, userId, date = null) {
	const d = date || todayLondon();
	const { results } = await env.DB.prepare(
		'SELECT activities FROM mood_journal WHERE user_id = ? AND date = ? AND activities IS NOT NULL'
	).bind(userId, d).all();
	const seen = new Set();
	for (const row of (results || [])) {
		const parsed = safeParseJSON(row.activities);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (typeof item === 'string') seen.add(item);
			}
		}
	}
	return Array.from(seen);
}

/**
 * Apply additions and removals to today's evening row's activities array in
 * one transaction. Used by the activities keyboard's Done callback.
 *
 * Behaviour:
 *   - Reads the current evening row's activities (creates the row if missing).
 *   - Adds anything in `additions` not already present.
 *   - Removes anything in `removals` if present.
 *   - Writes the merged array back. Returns { final, added, removed } where
 *     added/removed are the deltas actually applied (so callers can render an
 *     accurate summary even if the user double-tapped or selected an already-
 *     logged item).
 */
export async function mergeActivities(env, userId, date, entryType, additions, removals, source) {
	const existing = await getEntry(env, userId, date, entryType);
	let current = [];
	if (existing?.activities) {
		try { current = JSON.parse(existing.activities); } catch { current = []; }
		if (!Array.isArray(current)) current = [];
	}

	const before = new Set(current);
	const added = [];
	for (const a of (additions || [])) {
		if (typeof a === 'string' && !before.has(a)) {
			before.add(a);
			added.push(a);
		}
	}
	const removed = [];
	for (const r of (removals || [])) {
		if (typeof r === 'string' && before.has(r)) {
			before.delete(r);
			removed.push(r);
		}
	}
	const final = Array.from(before);

	await upsertEntry(env, userId, date, entryType, {
		activities: JSON.stringify(final),
		source: source || existing?.source || 'inline_chat',
	});

	return { final, added, removed };
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
