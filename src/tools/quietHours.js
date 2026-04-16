/**
 * Quiet Hours Tool — lets Xaridotis respect natural "do not disturb" requests.
 *
 * Usage from Gemini's perspective: when the user says things like
 * "don't disturb me for 2 hours", "I'm in deep work until 5pm",
 * "leave me alone today", "shut up", or "I'm busy", call set_quiet_hours
 * with an end_unix timestamp. To cancel early, call with end_unix=0
 * or use clear_quiet_hours.
 *
 * Implementation: writes KV key `quiet_until_${chatId}` with unix timestamp
 * value and TTL matching the window. Proactive outreach handlers
 * (handleSpontaneousOutreach, handleDailyStudy share step, handleCuriosityDigest)
 * check this key before firing and skip if Date.now() < stored_time.
 *
 * Deliberately does NOT silence health check-ins (Option B). Medication
 * timing matters for ADHD + bipolar care.
 */
export const quietHoursTool = {
	definition: {
		name: "set_quiet_hours",
		description: "Silence proactive outreach (spontaneous messages, daily study shares, weekly digest) for a specified window. Call this when the user says 'don't disturb me', 'I'm busy', 'leave me alone', 'shut up', 'I'm in deep work', or similar natural requests for quiet time. Does NOT silence medication check-ins — those run regardless to protect the user's clinical care. For vague requests without a specific duration ('a bit', 'leave me alone'), default to 2 hours. For 'today', set until 23:59 London time. For 'until Xpm', parse to today's Xpm in London time. If the user later says 'you can talk again' or 'never mind', call with end_unix=0 to clear.",
		parameters: {
			type: "OBJECT",
			properties: {
				end_unix: {
					type: "INTEGER",
					description: "Unix timestamp (seconds) when quiet hours should end. Use 0 to clear quiet hours immediately. For '2 hours from now', pass (current_unix + 7200). For 'today', use end-of-day London time."
				},
				reason: {
					type: "STRING",
					description: "Optional short reason the user gave (e.g. 'deep work', 'meeting', 'rest'). Used only for logging."
				}
			},
			required: ["end_unix"]
		}
	},
	async execute(args, env, context) {
		const chatId = context.chatId;
		const nowSec = Math.floor(Date.now() / 1000);
		const endUnix = Number(args.end_unix) || 0;
		const reason = args.reason || '';

		// Clear request: end_unix = 0 or in the past
		if (endUnix === 0 || endUnix <= nowSec) {
			await env.CHAT_KV.delete(`quiet_until_${chatId}`);
			return { status: "success", message: "Quiet hours cleared. I'll resume normal outreach.", cleared: true };
		}

		// Sanity cap: never silence for more than 48 hours via a single call
		const maxEnd = nowSec + (48 * 3600);
		const cappedEnd = Math.min(endUnix, maxEnd);
		const secondsUntil = cappedEnd - nowSec;

		// Store with TTL matching the window so the key expires naturally
		await env.CHAT_KV.put(
			`quiet_until_${chatId}`,
			String(cappedEnd),
			{ expirationTtl: secondsUntil + 60 } // small buffer so the check succeeds right at the boundary
		);

		// Format end time in London 24h for acknowledgement
		const endDate = new Date(cappedEnd * 1000);
		const endLabel = endDate.toLocaleString('en-GB', {
			timeZone: 'Europe/London',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'short'
		});

		const capped = cappedEnd < endUnix;
		return {
			status: "success",
			quiet_until_unix: cappedEnd,
			quiet_until_label: endLabel,
			capped_to_48h: capped,
			reason,
			message: capped
				? `Silencing proactive messages until ${endLabel} (capped to 48 hours max). Medication check-ins still fire.`
				: `Silencing proactive messages until ${endLabel}. Medication check-ins still fire.`
		};
	}
};

/**
 * Clear Quiet Hours Tool — explicit cancellation.
 * Separate tool because Gemini sometimes finds it easier to call a named
 * "clear" action than to set end_unix=0. Both paths work.
 */
export const clearQuietHoursTool = {
	definition: {
		name: "clear_quiet_hours",
		description: "Cancel any active quiet hours window and resume normal proactive outreach. Call this when the user says 'you can talk again', 'never mind', 'I'm free now', or similar.",
		parameters: {
			type: "OBJECT",
			properties: {}
		}
	},
	async execute(args, env, context) {
		await env.CHAT_KV.delete(`quiet_until_${context.chatId}`);
		return { status: "success", message: "Quiet hours cleared. I'll resume normal outreach." };
	}
};

/**
 * Shared helper — check if a chat is currently in a quiet hours window.
 * Used by all proactive outreach handlers in index.js to gate firing.
 *
 * @param {object} env - Worker env with CHAT_KV binding
 * @param {number|string} chatId - Telegram chat id
 * @returns {Promise<boolean>} true if currently quiet, false otherwise
 */
export async function isQuietTime(env, chatId) {
	try {
		const stored = await env.CHAT_KV.get(`quiet_until_${chatId}`);
		if (!stored) return false;
		const endUnix = parseInt(stored);
		if (!endUnix) return false;
		return Math.floor(Date.now() / 1000) < endUnix;
	} catch {
		return false; // fail open — don't silence on infra errors
	}
}
