import { handleMessage, handleCallback } from './bot/handlers';
import * as reminderStore from './services/reminderStore';
import * as telegram from './lib/telegram';
import { generateSpeech } from './lib/tts';

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

		if (update.callback_query) ctx.waitUntil(handleCallback(update.callback_query, env));
		else if (update.message) ctx.waitUntil(handleMessage(update.message, env));

		return new Response("OK");
	},

	async scheduled(event, env, ctx) {
		const reminders = await reminderStore.getDueReminders(env);

		for (const r of reminders) {
			const threadId = r.thread_id || "default";
			const meta = r.parsedMeta || {};
			const firstName = meta.firstName || "mate";
			const reason = meta.reason || "Scheduled task";

			const isGroup = r.recipient_chat_id !== r.creator_chat_id;
			let reminderText = `⏰ <b>Reminder:</b> ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;

			if (isGroup) {
				reminderText = `⏰ <b>${firstName}</b>, reminder: ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;
			}

			await telegram.sendMessage(
				r.recipient_chat_id, threadId, reminderText, env, r.original_message_id
			);

			const personaKey = meta.persona || await env.CHAT_KV.get(`persona_${r.creator_chat_id}`) || "gemini";
			try {
				const audio = await generateSpeech(r.text, personaKey, env);
				await telegram.sendVoice(r.recipient_chat_id, threadId, audio, env, r.original_message_id);
			} catch (e) { console.error("Cron voice error:", e.message); }

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
		}
	}
};
