/**
 * Timezone Tool — lets Gemini update the user's timezone conversationally.
 * Stored in KV so all cron jobs and check-ins use it.
 */
export const timezoneTool = {
	definition: {
		name: "update_timezone",
		description: "Update the user's timezone. Use this when the user mentions they are travelling, moved, or asks to change their timezone. Valid timezone strings are IANA format like 'Europe/London', 'America/New_York', 'Asia/Tokyo', etc.",
		parameters: {
			type: "OBJECT",
			properties: {
				timezone: { type: "STRING", description: "IANA timezone string (e.g. 'Europe/London', 'America/New_York', 'Asia/Dubai')" }
			},
			required: ["timezone"]
		}
	},
	async execute(args, env, context) {
		// Validate timezone
		try {
			new Date().toLocaleString('en-US', { timeZone: args.timezone });
		} catch {
			return { status: "error", message: `Invalid timezone: ${args.timezone}. Use IANA format like 'Europe/London'.` };
		}
		await env.CHAT_KV.put(`timezone_${context.chatId}`, args.timezone);
		return { status: "success", timezone: args.timezone, message: `Timezone updated to ${args.timezone}. All check-ins and reminders will now use this timezone.` };
	}
};
