import { handleMessage, handleCallback } from './bot/handlers';
import { handleInlineQuery } from './bot/inlineHandler';
import * as reminderStore from './services/reminderStore';
import * as moodStore from './services/moodStore';
import * as telegram from './lib/telegram';
import { generateSpeech } from './lib/tts';
import { storeDiscoveredEffect } from './tools/effect';
import { personas } from './config/personas';

const BIZ_CONN_TTL = 2592000; // 30 days

// Known effect IDs to emoji mapping (for discovery logging)
const KNOWN_EFFECT_EMOJIS = {
	"5159385139981059251": "❤️",
	"5107584321108051014": "👍",
	"5104858069142078462": "👎",
	"5070445174516318631": "🔥",
	"5066970843586925436": "🎉",
	"5046589136895476101": "💩",
	"5104841245755180586": "❤️",  // alternate hearts ID
};

function extractEffectEmoji(msg, effectId) {
	// First check if we already know this effect ID
	if (KNOWN_EFFECT_EMOJIS[effectId]) return KNOWN_EFFECT_EMOJIS[effectId];

	// Try to extract from the message text
	const text = (msg.text || "").trim();
	if (!text) return null;

	// If the message is just a single emoji (up to 4 bytes), use it
	if (text.length <= 4) return text;

	// Try to extract the first emoji from any message
	const emojiMatch = text.match(/(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
	return emojiMatch ? emojiMatch[0] : `effect_${effectId.slice(-6)}`;
}

// ---- Health Check-in Scheduler ----
// Runs inside the cron handler. Checks London time and sends check-ins as Nightfall.
async function handleHealthCheckIns(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const hour = londonTime.getHours();
	const minute = londonTime.getMinutes();
	const chatId = Number(env.OWNER_ID);
	const threadId = 'default';

	// Only trigger at specific minutes to avoid duplicate sends (cron runs every minute)
	// Use KV to track if we already sent this check-in today
	const today = londonTime.toISOString().split('T')[0];

	// Morning: 08:30+
	if (hour === 8 && minute >= 30) {
		const key = `health_checkin_morning_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		// Set Nightfall as active persona for health check-in
		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'morning', { expirationTtl: 3600 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'morning');
		if (alreadyLogged) return;

		await telegram.sendMessage(chatId, threadId,
			`🌙 <b>Nightfall here.</b> Good morning.\n\nHow did you sleep? And have you taken your morning medication yet?`,
			env, null, {
				inline_keyboard: [[
					{ text: '💊 Taken', callback_data: 'mood_med_yes_morning' },
					{ text: '⏰ Not yet', callback_data: 'mood_med_no_morning' },
				]]
			});
	}

	// Midday: 13:00+
	else if (hour === 13 && minute >= 0) {
		const key = `health_checkin_midday_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'midday', { expirationTtl: 3600 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'midday');
		if (alreadyLogged) return;

		await telegram.sendMessage(chatId, threadId,
			`🌙 <b>Nightfall checking in.</b> Quick midday pulse.\n\nHave you taken your ADHD and anxiety medication?`,
			env, null, {
				inline_keyboard: [[
					{ text: '✅ Both taken', callback_data: 'mood_med_yes_midday' },
					{ text: '💊 ADHD only', callback_data: 'mood_med_partial_midday' },
					{ text: '❌ Not yet', callback_data: 'mood_med_no_midday' },
				]]
			});
	}

	// Evening: 20:30+
	else if (hour === 20 && minute >= 30) {
		const key = `health_checkin_evening_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 7200 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'evening');
		if (alreadyLogged) return;

		// Evening: send a poll for mood score
		// Evening: send formatted message with mood scale descriptions + clean buttons
		await telegram.sendMessage(chatId, threadId,
			`🌙 <b>Nightfall here for your evening check-in.</b>\n\nLet's take a moment to reflect on your day. Where would you place yourself on the mood scale right now?\n\n🔴 <b>0-1: Severe Depression</b>\n<i>(Bleak, no movement, hopeless)</i>\n\n🟠 <b>2-3: Mild/Moderate</b>\n<i>(Struggle, slow thinking, anxious)</i>\n\n🟢 <b>4-6: Balanced</b>\n<i>(Good decisions, sociable, optimistic)</i>\n\n🟡 <b>7-8: Hypomania</b>\n<i>(Very productive, racing thoughts)</i>\n\n🔴 <b>9-10: Mania</b>\n<i>(Reckless, lost touch with reality)</i>`,
			env, null, {
				inline_keyboard: [
					[{ text: '🔴 0-1', callback_data: 'mood_score_1' }, { text: '🟠 2-3', callback_data: 'mood_score_3' }],
					[{ text: '🟢 4-6', callback_data: 'mood_score_5' }],
					[{ text: '🟡 7-8', callback_data: 'mood_score_7' }, { text: '🔴 9-10', callback_data: 'mood_score_9' }]
				]
			});
	}
}

export default {
	async fetch(request, env, ctx) {
		if (!telegram.verifyWebhook(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/register-commands") {
			const result = await telegram.registerCommands(env);
			return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/setup-webhook") {
			const url = new URL(request.url);
			const workerUrl = `${url.protocol}//${url.host}/`;
			const params = new URLSearchParams({ url: workerUrl });
			if (env.WEBHOOK_SECRET) params.set("secret_token", env.WEBHOOK_SECRET);
			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?${params}`);
			const data = await res.json();
			return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method !== "POST") return new Response("OK");
		const update = await request.json();

		let task;

		if (update.business_connection) {
			const bc = update.business_connection;
			const userId = bc.user?.id;
			console.log("🏢 Business connection:", bc.id, "user:", userId, "enabled:", bc.is_enabled);
			if (bc.is_enabled && !bc.is_disabled && userId) {
				await env.CHAT_KV.put(`biz_conn_${userId}`, bc.id, { expirationTtl: BIZ_CONN_TTL });
				console.log(`🏢 Stored business connection ${bc.id} for user ${userId}`);
			} else if (userId) {
				await env.CHAT_KV.delete(`biz_conn_${userId}`);
				console.log(`🏢 Removed business connection for user ${userId}`);
			}
		}
		else if (update.business_message) {
			const bizMsg = update.business_message;
			if (bizMsg.business_connection_id && bizMsg.from?.id) {
				await env.CHAT_KV.put(`biz_conn_${bizMsg.from.id}`, bizMsg.business_connection_id, { expirationTtl: BIZ_CONN_TTL });
			}
			if (bizMsg.effect_id) {
				const emoji = extractEffectEmoji(bizMsg, bizMsg.effect_id);
				console.log(`✨ Effect discovered: ${bizMsg.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, bizMsg.effect_id, emoji);
			}
			task = handleMessage(bizMsg, env);
		}
		else if (update.inline_query) task = handleInlineQuery(update.inline_query, env);
		else if (update.callback_query) task = handleCallback(update.callback_query, env);
		else if (update.message) {
			if (update.message.effect_id) {
				const emoji = extractEffectEmoji(update.message, update.message.effect_id);
				console.log(`✨ Effect discovered: ${update.message.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, update.message.effect_id, emoji);
			}
			task = handleMessage(update.message, env);
		}

		if (task) await task;
		return new Response("OK");
	},

	// eslint-disable-next-line no-unused-vars
	async scheduled(_event, env, _ctx) {
		// ---- Health check-ins (owner only, Nightfall persona) ----
		if (env.OWNER_ID) {
			await handleHealthCheckIns(env);
		}

		// ---- Reminders ----
		const reminders = await reminderStore.getDueReminders(env);
		if (!reminders.length) return;

		const tasks = reminders.map(async (r) => {
			const threadId = r.thread_id || "default";
			const meta = r.parsedMeta || {};
			const firstName = meta.firstName || "mate";
			const reason = meta.reason || "Scheduled task";

			const isGroup = r.recipient_chat_id !== r.creator_chat_id;
			// noinspection HtmlUnknownAttribute
			let reminderText = `⏰ <b>Reminder:</b> ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;
			if (isGroup) {
				reminderText = `⏰ <b>${firstName}</b>, reminder: ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;
			}

			const personaKey = meta.persona || await env.CHAT_KV.get(`persona_${r.creator_chat_id}`) || "tenon";
			await Promise.all([
				telegram.sendMessage(r.recipient_chat_id, threadId, reminderText, env, r.original_message_id),
				generateSpeech(r.text, personaKey, env)
					.then(audio => telegram.sendVoice(r.recipient_chat_id, threadId, audio, env, r.original_message_id))
					.catch(e => console.error("Cron voice error:", e.message))
			]);

			if (r.recurrence_type && r.recurrence_type !== "none") {
				let next = r.due_at;
				if (r.recurrence_type === "daily") next += 86400;
				else if (r.recurrence_type === "weekly") next += 604800;
				else if (r.recurrence_type === "monthly") {
					const d = new Date(r.due_at * 1000);
					d.setMonth(d.getMonth() + 1);
					next = Math.floor(d.getTime() / 1000);
				}
				await reminderStore.updateRecurrence(env, r.id, next);
			} else {
				await reminderStore.clearReminder(env, r.id);
			}
		});

		const BATCH_SIZE = 5;
		for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
			await Promise.all(tasks.slice(i, i + BATCH_SIZE));
		}
	}
};
