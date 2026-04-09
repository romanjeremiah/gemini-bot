// Auto-upsert user identity from Telegram message data into D1.
// Called on every message to keep names/usernames fresh.

export async function upsertUser(env, msg) {
	const from = msg.from;
	if (!from?.id) return null;

	const userId = from.id;
	const firstName = from.first_name || null;
	const lastName = from.last_name || null;
	const username = from.username || null;

	try {
		await env.DB.prepare(
			`INSERT INTO users (user_id, first_name, last_name, username, last_seen_at, updated_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			 ON CONFLICT(user_id) DO UPDATE SET
			   first_name = excluded.first_name,
			   last_name = excluded.last_name,
			   username = excluded.username,
			   last_seen_at = CURRENT_TIMESTAMP,
			   updated_at = CURRENT_TIMESTAMP`
		).bind(userId, firstName, lastName, username).run();
	} catch (e) {
		console.error("⚠️ upsertUser failed:", e.message);
	}

	return { userId, firstName, lastName, username };
}

// Build a rich user identity string for the system prompt / dynamic context.
// Includes full name, @username, and Telegram user ID so Gemini can:
// 1. Address the user by their real name
// 2. Store memories tagged to a specific person (not just "User")
// 3. Distinguish between different users in group chats
export function buildUserIdentity(msg) {
	const from = msg.from;
	if (!from) return "Unknown user";

	let identity = from.first_name || "User";
	if (from.last_name) identity += ` ${from.last_name}`;
	if (from.username) identity += ` (@${from.username})`;
	identity += ` [uid:${from.id}]`;
	return identity;
}
