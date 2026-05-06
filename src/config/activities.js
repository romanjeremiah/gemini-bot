// Canonical list of activities for mood journal multi-select.
// Index is stable and used in callback_data (mood_act|<idx>) to keep payloads
// under Telegram's 64-byte callback limit. NEVER reorder this list — indices
// are persisted in user state during an active flow. Append new activities at
// the end only.
//
// Used by:
//   - src/bot/handlers.js — keyboard renderer + callback handler
//   - src/tools/mood.js — log_mood_entry tool description (lists valid activities)
//   - src/lib/moodFlow.js — pending state validation

export const ACTIVITIES = [
	// Relationships (0-3)
	{ key: 'intimacy',       label: 'intimacy' },
	{ key: 'boyfriend',      label: 'boyfriend' },
	{ key: 'friends',        label: 'friends' },
	{ key: 'family',         label: 'family' },
	// Body / movement (4-10)
	{ key: 'gym',            label: 'gym' },
	{ key: 'swimming',       label: 'swimming' },
	{ key: 'cycling',        label: 'cycling' },
	{ key: 'rollerblading',  label: 'rollerblading' },
	{ key: 'sport',          label: 'sport' },
	{ key: 'walking',        label: 'walking' },
	{ key: 'park',           label: 'park' },
	// Mind / work (11-14)
	{ key: 'work',           label: 'work' },
	{ key: 'study',          label: 'study' },
	{ key: 'reading',        label: 'reading' },
	{ key: 'job_search',     label: 'job search' },
	// Home (15-16)
	{ key: 'cleaning',       label: 'cleaning' },
	{ key: 'shopping',       label: 'shopping' },
	// Downtime (17-25)
	{ key: 'games',          label: 'games' },
	{ key: 'movies',         label: 'movies' },
	{ key: 'music',          label: 'music' },
	{ key: 'chatting',       label: 'chatting' },
	{ key: 'pets',           label: 'pets' },
	{ key: 'eating',         label: 'eating' },
	{ key: 'sleep',          label: 'sleep' },
	{ key: 'relaxation',     label: 'relaxation' },
	{ key: 'internet',       label: 'internet' },
];

// Quick lookup helpers
export const ACTIVITY_KEYS = ACTIVITIES.map(a => a.key);
export const ACTIVITY_BY_KEY = Object.fromEntries(ACTIVITIES.map((a, i) => [a.key, { ...a, idx: i }]));
export const ACTIVITY_BY_IDX = (idx) => ACTIVITIES[idx] || null;

// Comma-separated string for tool descriptions / persona instructions
export const ACTIVITY_LABELS_CSV = ACTIVITIES.map(a => a.label).join(', ');

/**
 * Validate and canonicalise a list of activity keys/labels submitted by the
 * AI or by callback. Drops anything that doesn't match the canonical list
 * (case-insensitive, trims, normalises spaces ↔ underscores).
 *
 * Returns array of canonical keys, deduplicated.
 */
export function canonicaliseActivities(items) {
	if (!Array.isArray(items)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of items) {
		if (typeof raw !== 'string') continue;
		const norm = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
		// Exact key match
		if (ACTIVITY_BY_KEY[norm]) {
			if (!seen.has(norm)) { seen.add(norm); out.push(norm); }
			continue;
		}
		// Label match (e.g. "job search" → "job_search")
		const labelMatch = ACTIVITIES.find(a => a.label.toLowerCase() === raw.toLowerCase().trim());
		if (labelMatch && !seen.has(labelMatch.key)) {
			seen.add(labelMatch.key);
			out.push(labelMatch.key);
		}
	}
	return out;
}
