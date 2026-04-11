import { setSchedule, resetSchedule, getAllSchedules } from '../config/schedules';

export const scheduleTool = {
	definition: {
		name: "update_schedule",
		description: "Update the timing of a scheduled bot feature. Use this when the user asks to change when check-ins, reports, or other scheduled events occur. Valid schedule keys: morning_checkin, midday_checkin, evening_checkin, weekly_report, accountability_nudge, curiosity_digest, autonomous_research_1, autonomous_research_2, self_improvement, memory_consolidation, architecture_evolution.",
		parameters: {
			type: "OBJECT",
			properties: {
				schedule_key: {
					type: "STRING",
					description: "The schedule to update (e.g., 'morning_checkin', 'evening_checkin', 'weekly_report')."
				},
				hour: { type: "INTEGER", description: "New hour (0-23) in London time." },
				minute: { type: "INTEGER", description: "New minute (0-59). Defaults to 0." },
				day: { type: "INTEGER", description: "New day of week (0=Sun, 1=Mon, ..., 6=Sat). Only for weekly schedules." },
				action: {
					type: "STRING",
					enum: ["update", "reset", "list"],
					description: "'update' to change, 'reset' to restore default, 'list' to show all schedules."
				}
			},
			required: ["schedule_key", "action"]
		}
	},
	async execute(args, env) {
		if (args.action === 'list') {
			const all = await getAllSchedules(env);
			return { status: 'success', schedules: all };
		}
		if (args.action === 'reset') {
			const result = await resetSchedule(env, args.schedule_key);
			return { status: 'success', message: `Reset ${args.schedule_key} to default`, schedule: result };
		}
		const updates = {};
		if (args.hour !== undefined) updates.hour = args.hour;
		if (args.minute !== undefined) updates.minute = args.minute;
		if (args.day !== undefined) updates.day = args.day;
		const result = await setSchedule(env, args.schedule_key, updates);
		return { status: 'success', message: `Updated ${args.schedule_key}`, schedule: result };
	}
};
