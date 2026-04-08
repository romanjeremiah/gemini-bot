import { handleMessage, handleCallback } from './bot/handlers';
import * as reminderStore from './services/reminderStore';
import * as telegram from './lib/telegram';
import { generateSpeech } from './lib/tts';
import { storeDiscoveredEffect } from './tools/effect';

const BIZ_CONN_TTL = 2592000; // 30 days

function extractEffectEmoji(msg) {
	const text = (msg.text || "").trim();
	if (text.length <= 4) return text;
	const emojiMatch = text.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
	return emojiMatch ? emojiMatch[0] : null;
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
				const emoji = extractEffectEmoji(bizMsg);
				console.log(`✨ Effect discovered: ${bizMsg.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, bizMsg.effect_id, emoji);
			}
			task = handleMessage(bizMsg, env);
		}
		else if (update.callback_query) task = handleCallback(update.callback_query, env);
		else if (update.message) {
			if (update.message.effect_id) {
				const emoji = extractEffectEmoji(update.message);
				console.log(`✨ Effect discovered: ${update.message.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, update.message.effect_id, emoji);
			}
			task = handleMessage(update.message, env);
		}

		if (task) ctx.waitUntil(task);
		return new Response("OK");
	},

	// eslint-disable-next-line no-unused-vars
	async scheduled(_event, env, _ctx) {
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

			const personaKey = meta.persona || await env.CHAT_KV.get(`persona_${r.creator_chat_id}`) || "gemini";
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
