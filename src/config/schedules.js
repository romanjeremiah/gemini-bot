// Schedule Configuration
// Stores default schedules and provides helpers to read/write from KV.
// Schedules are stored in CHAT_KV with the prefix "schedule_".
// This allows the bot to modify its own schedule without redeploying.

export const DEFAULT_SCHEDULES = {
	morning_checkin: { hour: 8, minute: 30, label: 'Morning check-in' },
	midday_checkin: { hour: 13, minute: 0, label: 'Midday check-in' },
	evening_checkin: { hour: 20, minute: 30, label: 'Evening check-in' },
	weekly_report: { day: 0, hour: 20, label: 'Weekly report (Sunday)' },
	accountability_nudge: { day: 3, hour: 16, label: 'Mid-week nudge (Wednesday)' },
	curiosity_digest: { day: 6, hour: 10, label: 'Curiosity digest (Saturday)' },
	autonomous_research_1: { day: 2, hour: 4, label: 'Research (Tuesday)' },
	autonomous_research_2: { day: 5, hour: 4, label: 'Research (Friday)' },
	self_improvement: { date: 15, hour: 5, label: 'Self-improvement (15th)' },
	memory_consolidation: { date: 1, hour: 3, label: 'REM sleep (1st)' },
	architecture_evolution: { day: 1, hour: 4, label: 'Architecture review (Monday)' },
	daily_study: { hour: 6, minute: 0, label: 'Daily study session' },
};

/**
 * Get a schedule value from KV, falling back to default.
 */
export async function getSchedule(env, key) {
	const cached = await env.CHAT_KV.get(`schedule_${key}`);
	if (cached) {
		try { return JSON.parse(cached); }
		catch { return DEFAULT_SCHEDULES[key] || null; }
	}
	return DEFAULT_SCHEDULES[key] || null;
}

/**
 * Update a schedule value in KV.
 */
export async function setSchedule(env, key, value) {
	const merged = { ...(DEFAULT_SCHEDULES[key] || {}), ...value };
	await env.CHAT_KV.put(`schedule_${key}`, JSON.stringify(merged));
	return merged;
}

/**
 * Get all schedules (defaults merged with any KV overrides).
 */
export async function getAllSchedules(env) {
	const result = {};
	for (const [key, defaults] of Object.entries(DEFAULT_SCHEDULES)) {
		const override = await env.CHAT_KV.get(`schedule_${key}`);
		if (override) {
			try { result[key] = { ...defaults, ...JSON.parse(override) }; }
			catch { result[key] = defaults; }
		} else {
			result[key] = defaults;
		}
	}
	return result;
}

/**
 * Reset a schedule back to its default.
 */
export async function resetSchedule(env, key) {
	await env.CHAT_KV.delete(`schedule_${key}`);
	return DEFAULT_SCHEDULES[key];
}

/**
 * Check if the current London time matches a schedule.
 */
export function matchesSchedule(londonTime, schedule) {
	if (schedule.date !== undefined && londonTime.getDate() !== schedule.date) return false;
	if (schedule.day !== undefined && londonTime.getDay() !== schedule.day) return false;
	if (schedule.hour !== undefined && londonTime.getHours() !== schedule.hour) return false;
	if (schedule.minute !== undefined && londonTime.getMinutes() !== schedule.minute) return false;
	return true;
}
