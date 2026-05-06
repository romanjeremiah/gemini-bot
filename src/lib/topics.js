// ============================================================
// Private Chat Topics — Bot API 9.4+ (Feb 2026)
//
// Default topics in the bot's private chat:
//   🧠 Second Brain     research, autonomous discoveries, daily study
//   ❤️ Mood Journal     check-ins, mood polls, therapeutic notes
//   📊 Weekly Reports   weekly mental health report, monthly consolidation
//   General             everything else (no message_thread_id sent)
//
// KV is the source of truth. Existing thread IDs are never overwritten.
// ============================================================

export const TOPIC_KEYS = {
	SECOND_BRAIN: "secondBrain",
	MOOD_JOURNAL: "moodJournal",
	WEEKLY_REPORTS: "weeklyReports",
	GENERAL: "general"
};

const TOPIC_SPECS = [
	{ key: TOPIC_KEYS.SECOND_BRAIN,   name: "🧠 Second Brain",   icon_color: 0x6FB9F0 },
	{ key: TOPIC_KEYS.MOOD_JOURNAL,   name: "❤️ Mood Journal",   icon_color: 0xFF93B2 },
	{ key: TOPIC_KEYS.WEEKLY_REPORTS, name: "📊 Weekly Reports", icon_color: 0xFFD67E }
];

const kvKey = (chatId) => `topics_${chatId}`;

// ---- Read the current topic map for a chat ----
export async function getTopicMap(env, chatId) {
	const map = await env.CHAT_KV.get(kvKey(chatId), { type: "json" });
	return map || {};
}

// ---- Resolve numeric thread_id for a kind, or null for General ----
export async function getThreadFor(env, chatId, kind) {
	if (!kind || kind === TOPIC_KEYS.GENERAL) return null;
	const map = await getTopicMap(env, chatId);
	return map[kind] ?? null;
}

// ---- Convenience: returns "default" or stringified thread_id ----
// Always safe to pass directly to telegram.sendMessage / sendPoll / etc,
// which treat "default" as "no message_thread_id".
export async function threadOrDefault(env, chatId, kind) {
	const id = await getThreadFor(env, chatId, kind);
	return id ? String(id) : "default";
}

// ---- Idempotently ensure all default topics exist ----
// - Reads existing map from KV
// - Only creates topics whose ID is missing
// - Existing IDs are NEVER overwritten (per spec)
// - Returns the merged map
export async function ensureTopics(env, chatId) {
	const existing = await getTopicMap(env, chatId);
	const missing = TOPIC_SPECS.filter(s => !existing[s.key]);
	if (missing.length === 0) return existing;

	const merged = { ...existing };
	for (const spec of missing) {
		try {
			const res = await fetch(
				`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/createForumTopic`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chat_id: chatId,
						name: spec.name,
						icon_color: spec.icon_color
					})
				}
			);
			const data = await res.json();
			if (data.ok && data.result?.message_thread_id) {
				merged[spec.key] = data.result.message_thread_id;
				console.log(`✅ topic_created ${spec.key} thread=${data.result.message_thread_id}`);
			} else {
				// Common failures: user has topics disabled in BotFather,
				// rate limited, chat not found. Log and continue.
				console.error(`❌ topic_create_failed ${spec.key}:`, data.description);
			}
		} catch (e) {
			console.error(`❌ topic_create_threw ${spec.key}:`, e.message);
		}
	}

	await env.CHAT_KV.put(kvKey(chatId), JSON.stringify(merged));
	return merged;
}

// ---- Force-reset a single topic ----
// Use if the user deletes a topic in Telegram and wants it recreated.
// The next ensureTopics call will then recreate just the cleared one.
export async function clearTopic(env, chatId, kind) {
	const map = await getTopicMap(env, chatId);
	delete map[kind];
	await env.CHAT_KV.put(kvKey(chatId), JSON.stringify(map));
}
