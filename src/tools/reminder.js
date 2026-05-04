import * as reminderStore from '../services/reminderStore';
import { getTimezone } from '../lib/timezone';

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
		const result = await reminderStore.saveReminder(env, {
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

		// Dedup guard hit: tell the model so it can respond honestly to the user
		// ("that reminder is already scheduled") rather than confirming a save
		// that didn't happen. Without this the model would say "done!" while no
		// new row was created.
		if (result?.duplicate) {
			return {
				status: "duplicate_skipped",
				existing_reminder_id: result.existing_id,
				existing_due_at_utc: result.existing_due_at,
				note: "A near-identical reminder is already scheduled for the same time slot. No new reminder was created. Tell the user the reminder is already in place rather than claiming you scheduled a new one."
			};
		}

		return {
			status: "success",
			scheduled_at_utc: args.due_at_timestamp,
			display_hint: `Use this in your confirmation message to show the time in the user's timezone: include the text "Scheduled for: [time]" and the system will render it natively.`
		};
	}
};

// ---------------------------------------------------------------
// list_reminders — read-only discovery for the model.
//
// The model needs this to find the right reminder before calling update_reminder.
// Returns id, text preview, due time in BOTH UTC and user-local format, recurrence,
// and a snippet of the original context (`reason`) so the model can match user
// intent ("my morning affirmation") to the right row by content as well as time.
// ---------------------------------------------------------------
export const listRemindersTool = {
	definition: {
		name: "list_reminders",
		description: "List the user's pending reminders. Use this BEFORE calling update_reminder when you need to find which reminder the user is referring to. Returns id, text preview, due time (in user's local timezone), recurrence type, and context. Always call this first when the user asks to change, move, cancel, or otherwise modify an existing reminder — you need the reminder_id from the returned list to call update_reminder.",
		parameters: {
			type: "OBJECT",
			properties: {},
			required: []
		}
	},
	async execute(_args, env, context) {
		const rows = await reminderStore.getUserReminders(env, context.userId);
		const tz = await getTimezone(context.chatId, env);

		const reminders = rows.map(r => {
			const dueDate = new Date(r.due_at * 1000);
			const dueLocal = dueDate.toLocaleString('en-GB', {
				timeZone: tz,
				weekday: 'short',
				day: '2-digit',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			});

			let contextReason = '';
			try {
				const meta = JSON.parse(r.metadata || '{}');
				contextReason = (meta.reason || '').slice(0, 120);
			} catch { /* metadata might be malformed; fine to skip */ }

			return {
				reminder_id: r.id,
				text_preview: (r.text || '').slice(0, 200),
				due_at_utc: r.due_at,
				due_at_local: dueLocal,
				recurrence_type: r.recurrence_type || 'none',
				context: contextReason,
			};
		});

		return {
			status: 'success',
			total: reminders.length,
			timezone: tz,
			reminders,
			note: reminders.length === 0
				? "No pending reminders. Tell the user there's nothing scheduled."
				: "Use the reminder_id from this list when calling update_reminder. Match the user's request to the right reminder using both text_preview and due_at_local."
		};
	}
};

// ---------------------------------------------------------------
// update_reminder — modify or cancel an existing reminder by id.
//
// All fields except reminder_id are optional. Pass only what you want to change.
// Special: cancel=true deletes the reminder entirely.
//
// Identity by id is intentional. The model should call list_reminders first to
// resolve user intent ("my morning affirmation") to a numeric id, then update
// by id. Description-based matching was rejected as too fragile — ambiguous
// references could cancel the wrong reminder.
// ---------------------------------------------------------------
export const updateReminderTool = {
	definition: {
		name: "update_reminder",
		description: "Modify or cancel an existing reminder by id. Call list_reminders first to find the reminder_id. All fields except reminder_id are optional — pass only what you want to change. To cancel/delete a reminder, set cancel=true. Times must be in 24-hour UTC unix timestamp format. Examples: rewrite text → {reminder_id, new_text}; move time → {reminder_id, new_due_at_timestamp}; change frequency → {reminder_id, new_recurrence_type}; cancel → {reminder_id, cancel: true}.",
		parameters: {
			type: "OBJECT",
			properties: {
				reminder_id: {
					type: "INTEGER",
					description: "The numeric id of the reminder to update. Get this from list_reminders. NEVER guess or invent an id."
				},
				new_text: {
					type: "STRING",
					description: "Replacement reminder text. Same formatting rules as set_reminder — 24-hour times. Omit to leave unchanged."
				},
				new_due_at_timestamp: {
					type: "INTEGER",
					description: "New due time as Unix timestamp (UTC). For recurring reminders this becomes the next fire time; the recurrence rule continues from there. Omit to leave unchanged."
				},
				new_recurrence_type: {
					type: "STRING",
					enum: ["none", "daily", "weekly", "monthly"],
					description: "New recurrence pattern. Use 'none' to convert a recurring reminder to a one-off. Omit to leave unchanged."
				},
				new_context: {
					type: "STRING",
					description: "New 'why' context for the reminder. Same second-person rules as set_reminder. Omit to leave unchanged."
				},
				cancel: {
					type: "BOOLEAN",
					description: "Set to true to delete the reminder entirely. When true, all other 'new_*' fields are ignored."
				},
			},
			required: ["reminder_id"]
		}
	},
	async execute(args, env, context) {
		const result = await reminderStore.updateReminder(env, {
			userId: context.userId,
			id: args.reminder_id,
			newText: args.new_text,
			newDueAt: args.new_due_at_timestamp,
			newRecurrence: args.new_recurrence_type,
			newContext: args.new_context,
			cancel: args.cancel === true,
		});

		if (!result.ok) {
			// Not found OR not owned by this user. We collapse both to one error
			// so we don't leak whether a different user has that id.
			return {
				status: 'not_found',
				reminder_id: args.reminder_id,
				note: "No reminder found with that id for this user. Call list_reminders to see what's actually scheduled, then retry with a valid reminder_id."
			};
		}

		if (result.action === 'cancelled') {
			return {
				status: 'cancelled',
				reminder_id: args.reminder_id,
				cancelled_text_preview: (result.reminder?.text || '').slice(0, 100),
				note: "Reminder deleted. Tell the user it's cancelled."
			};
		}

		if (result.action === 'noop') {
			return {
				status: 'noop',
				reminder_id: args.reminder_id,
				note: "No changes were specified — you called update_reminder without any of new_text, new_due_at_timestamp, new_recurrence_type, new_context, or cancel. The reminder is unchanged. If the user did want a change, retry with the appropriate field."
			};
		}

		// Successful update. Return the new state so the model can confirm to the user.
		const tz = await getTimezone(context.chatId, env);
		const dueLocal = result.reminder?.due_at
			? new Date(result.reminder.due_at * 1000).toLocaleString('en-GB', {
				timeZone: tz,
				weekday: 'short',
				day: '2-digit',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			})
			: null;

		return {
			status: 'updated',
			reminder_id: args.reminder_id,
			new_state: {
				text_preview: (result.reminder?.text || '').slice(0, 200),
				due_at_utc: result.reminder?.due_at,
				due_at_local: dueLocal,
				recurrence_type: result.reminder?.recurrence_type || 'none',
			},
			note: "Reminder updated. Confirm the change to the user using the new_state details. Use due_at_local in your reply, not the UTC timestamp."
		};
	}
};
