import * as reminderStore from '../services/reminderStore';

export const reminderTool = {
	definition: {
		name: "set_reminder",
		description: "Schedule a reminder for the user. Calculate 'due_at_timestamp' as a Unix timestamp in UTC. The system prompt provides the current Unix time as an anchor. All times must be in UTC. SMART TIMING: If the user explicitly states a time, use it. If the user says 'remind me later' or gives a casual task without specifying a time (e.g., 'remind me to check the oven', 'remind me about this'), use your intelligence to assign a reasonable short delay (+5, +15, +30, or +60 minutes) based on the task's urgency. Do not pester for an exact time unless the task is clearly a major future event (flight, meeting, appointment). Set it and confirm the time you chose.",
		parameters: {
			type: "OBJECT",
			properties: {
				task_message: { type: "STRING", description: "The reminder text to deliver. Any times in the text MUST use 24-hour format (e.g. '20:00', NOT '8 PM'; '09:30', NOT '9:30 AM')." },
				context: { type: "STRING", description: "The 'why' behind this reminder, phrased as the user would say it to themselves. Use SECOND PERSON ('you', 'your') or neutral verb phrases. NEVER use third person ('Roman', 'he', 'his', 'Roman promised...'). ALL times in 24-hour format (13:00, NOT '1 PM'; 20:30, NOT '8:30 PM'). Good: 'You said you would take it 30 min after the 13:00 check-in', 'Promised to text Mum about the weekend'. Bad: 'Roman promised to take his medication', 'after our 1 PM check-in'. Keep it brief — one sentence maximum." },
				due_at_timestamp: { type: "INTEGER", description: "Unix timestamp (UTC) when the reminder should fire" },
				recurrence_type: { type: "STRING", enum: ["none", "daily", "weekly", "monthly"] },
				original_user_request: { type: "STRING", description: "The user's original message that triggered this reminder, for context" }
			},
			required: ["task_message", "context", "due_at_timestamp", "recurrence_type"]
		}
	},
	async execute(args, env, context) {
		await reminderStore.saveReminder(env, {
			userId: context.userId,
			chatId: context.chatId,
			threadId: context.threadId,
			text: args.task_message,
			dueAt: args.due_at_timestamp,
			messageId: context.messageId,
			recurrence: args.recurrence_type,
			context: {
				reason: args.context,
				originalRequest: args.original_user_request || "",
				persona: context.activePersona || "gemini",
				firstName: context.firstName || "User",
				createdAt: Math.floor(Date.now() / 1000)
			}
		});
		return {
			status: "success",
			scheduled_at_utc: args.due_at_timestamp,
			display_hint: `Use this in your confirmation message to show the time in the user's timezone: include the text "Scheduled for: [time]" and the system will render it natively.`
		};
	}
};
