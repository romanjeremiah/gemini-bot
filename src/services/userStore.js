// Auto-upsert user identity from Telegram message data into D1.
// Called on every message to keep profiles fresh.
// All data keyed by user_id (Telegram from.id), not chat_id.

export async function upsertUser(env, msg) {
	const from = msg.from;
	if (!from?.id) return null;

	const userId = from.id;
	const firstName = from.first_name || null;
	const username = from.username || null;
	const languageCode = from.language_code || 'en';

	try {
		// Upsert into user_profiles (the single identity table)
		await env.DB.prepare(
			`INSERT INTO user_profiles (user_id, first_name, username, language_code, updated_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(user_id) DO UPDATE SET
			   first_name = excluded.first_name,
			   username = excluded.username,
			   language_code = excluded.language_code,
			   updated_at = CURRENT_TIMESTAMP`
		).bind(userId, firstName, username, languageCode).run();

		// Ensure persona_config rows exist (seeds all built-in personas on first contact)
		const { ensurePersonas } = await import('./personaStore');
		await ensurePersonas(env, userId);
	} catch (e) {
		console.error('⚠️ upsertUser failed:', e.message);
	}

	return { userId, firstName, username };
}

// Build a rich user identity string for the system prompt.
export function buildUserIdentity(msg) {
	const from = msg.from;
	if (!from) return 'Unknown user';

	let identity = from.first_name || 'User';
	if (from.last_name) identity += ` ${from.last_name}`;
	if (from.username) identity += ` (@${from.username})`;
	identity += ` [uid:${from.id}]`;
	return identity;
}

/**
 * Get user's timezone from their profile.
 */
export async function getUserTimezone(env, userId) {
	const row = await env.DB.prepare(
		'SELECT timezone FROM user_profiles WHERE user_id = ?'
	).bind(userId).first();
	return row?.timezone || 'Europe/London';
}

/**
 * Get the user's style card — a structured document of communication preferences,
 * interests, and subjective opinions. Loaded at the top of every system prompt
 * so Xaridotis does not have to infer these from scattered memories.
 *
 * Returns null if no style card is set (older users, new signups).
 */
export async function getStyleCard(env, userId) {
	try {
		const row = await env.DB.prepare(
			'SELECT style_card FROM user_profiles WHERE user_id = ?'
		).bind(userId).first();
		return row?.style_card || null;
	} catch (e) {
		console.error('⚠️ getStyleCard failed:', e.message);
		return null;
	}
}

/**
 * Update the user's style card in the database.
 */
export async function saveStyleCard(env, userId, styleCard) {
	try {
		await env.DB.prepare(
			'UPDATE user_profiles SET style_card = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
		).bind(styleCard, userId).run();
	} catch (e) {
		console.error('⚠️ saveStyleCard failed:', e.message);
	}
}
