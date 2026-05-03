// Schedule Configuration
// Stores default schedules and provides helpers to read/write from KV.
// Schedules are stored in CHAT_KV with the prefix "schedule_".
// This allows the bot to modify its own schedule without redeploying.
//
// Module-scope cache (Phase audit cleanup): cron runs every minute and
// previously hit KV three times per tick (once per check-in window) just to
// re-read schedules that change at most a few times per month. Cache is keyed
// by schedule name with a 5-minute TTL. setSchedule()/resetSchedule() bust the
// relevant entry so user-driven changes propagate within one cron tick.
//
// Why 5 min and not longer: schedules are stored in KV which is eventually
// consistent across regions. A 5-min TTL means a schedule change made in one
// region propagates to all cron-running regions within ~6 minutes worst case,
// which matches Roma's expectation when he says "move my morning to 09:00".
// Going longer would feel laggy; going shorter defeats the purpose.

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

const SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _scheduleCache = new Map(); // key -> { value, fetchedAt }

function _cacheGet(key) {
	const entry = _scheduleCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.fetchedAt > SCHEDULE_CACHE_TTL_MS) {
		_scheduleCache.delete(key);
		return null;
	}
	return entry.value;
}

function _cacheSet(key, value) {
	_scheduleCache.set(key, { value, fetchedAt: Date.now() });
}

function _cacheBust(key) {
	_scheduleCache.delete(key);
}

/**
 * Get a schedule value from KV, falling back to default. Cached for 5 minutes
 * in module scope to avoid hammering KV on every cron tick (cron runs every
 * minute and reads three schedules per tick).
 */
export async function getSchedule(env, key) {
	const cached = _cacheGet(key);
	if (cached !== null) return cached;

	const stored = await env.CHAT_KV.get(`schedule_${key}`);
	let value;
	if (stored) {
		try { value = JSON.parse(stored); }
		catch { value = DEFAULT_SCHEDULES[key] || null; }
	} else {
		value = DEFAULT_SCHEDULES[key] || null;
	}
	_cacheSet(key, value);
	return value;
}

/**
 * Update a schedule value in KV. Busts the module-scope cache for this key so
 * the change propagates to the next cron tick.
 */
export async function setSchedule(env, key, value) {
	const merged = { ...(DEFAULT_SCHEDULES[key] || {}), ...value };
	await env.CHAT_KV.put(`schedule_${key}`, JSON.stringify(merged));
	_cacheBust(key);
	return merged;
}

/**
 * Get all schedules (defaults merged with any KV overrides). Uses getSchedule
 * internally so cache is shared across both code paths.
 */
export async function getAllSchedules(env) {
	const result = {};
	for (const key of Object.keys(DEFAULT_SCHEDULES)) {
		result[key] = await getSchedule(env, key);
	}
	return result;
}

/**
 * Reset a schedule back to its default. Busts the cache for this key.
 */
export async function resetSchedule(env, key) {
	await env.CHAT_KV.delete(`schedule_${key}`);
	_cacheBust(key);
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
