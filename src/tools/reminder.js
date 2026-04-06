import * as reminderStore from '../services/reminderStore';

export const reminderTool = {
	definition: {
		name: "set_reminder",
		description: "Schedule a reminder for the user. Calculate 'due_at_timestamp' as a Unix timestamp in UTC. The system prompt provides the current Unix time as an anchor. All times must be in UTC.",
		parameters: {
			type: "OBJECT",
			properties: {
				task_message: { type: "STRING", description: "The reminder text to deliver" },
				context: { type: "STRING", description: "The 'why' or emotional context behind this reminder." },
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
		return { status: "success", scheduled_at_utc: args.due_at_timestamp };
	}
};
