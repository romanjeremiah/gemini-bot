// Timezone resolution from coordinates.
//
// Uses Google Maps Time Zone API to convert lat/lng → IANA timezone ID.
// API: https://maps.googleapis.com/maps/api/timezone/json
// Pricing: $5 per 1000 calls, 5000/month free. We call once per location pin,
// so cost is effectively zero for personal use.
//
// Storage: KV key `timezone_${chatId}` holds the IANA tz string.
// Default fallback: 'Etc/UTC' (GMT) when no location has been pinned.
//
// Reads/writes go through this module so we have one canonical place to manage
// the cache and the fallback policy. Replaces the previous mix of
// `user_timezone` (global) and `timezone_${chatId}` (per-chat) keys.

const DEFAULT_TIMEZONE = 'Etc/UTC';

/**
 * Resolve a (lat, lng) pair to an IANA timezone via Google Maps API.
 * Returns the tz string (e.g. 'Europe/Podgorica') or null on any failure.
 */
export async function resolveTimezone(lat, lng, env) {
	if (typeof lat !== 'number' || typeof lng !== 'number') return null;
	if (!env.GOOGLE_MAPS_API_KEY) {
		console.warn('GOOGLE_MAPS_API_KEY not set — cannot resolve timezone from coords');
		return null;
	}

	const ts = Math.floor(Date.now() / 1000);
	const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${ts}&key=${env.GOOGLE_MAPS_API_KEY}`;

	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn('Time Zone API HTTP error:', res.status);
			return null;
		}
		const data = await res.json();
		// Successful response has status:'OK' and timeZoneId field.
		// Failure modes: 'INVALID_REQUEST', 'OVER_QUERY_LIMIT', 'REQUEST_DENIED', 'UNKNOWN_ERROR', 'ZERO_RESULTS'.
		if (data.status !== 'OK' || !data.timeZoneId) {
			console.warn('Time Zone API non-OK status:', data.status, data.errorMessage);
			return null;
		}
		return data.timeZoneId;
	} catch (err) {
		console.warn('Time Zone API fetch failed:', err.message);
		return null;
	}
}

/**
 * Persist a (lat, lng) → tz mapping for a chat. Returns the resolved tz, or
 * null if resolution failed (in which case nothing is written).
 */
export async function setTimezoneFromCoords(chatId, lat, lng, env) {
	const tz = await resolveTimezone(lat, lng, env);
	if (!tz) return null;
	await env.CHAT_KV.put(`timezone_${chatId}`, tz);
	// Also store the location for later use (mood check-in geolocation, etc.)
	await env.CHAT_KV.put(`last_location_${chatId}`, JSON.stringify({ lat, lng, ts: Date.now() }));
	return tz;
}

/**
 * Get the stored timezone for a chat, or DEFAULT_TIMEZONE (UTC) if none.
 * Replaces the previous dual-key confusion (user_timezone vs timezone_${chatId}).
 */
export async function getTimezone(chatId, env) {
	if (!chatId) return DEFAULT_TIMEZONE;
	const stored = await env.CHAT_KV.get(`timezone_${chatId}`);
	return stored || DEFAULT_TIMEZONE;
}

/**
 * Get the current local time in the chat's stored timezone.
 * Returns a Date object whose getHours/getMinutes/getDay/getDate reflect local time.
 *
 * This is intentionally the same trick the existing code uses for London:
 *   new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
 * but with the chat's stored timezone substituted in.
 */
export async function getLocalTime(chatId, env, now = new Date()) {
	const tz = await getTimezone(chatId, env);
	return new Date(now.toLocaleString('en-US', { timeZone: tz }));
}

/**
 * For a given timezone, return a short human label like "CEST, UTC+2".
 * Used in the confirmation message after a location pin.
 */
export function describeOffset(tz, now = new Date()) {
	try {
		// Use formatToParts to get the timezone-shortname (e.g. "CEST", "PST").
		const parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			timeZoneName: 'short',
		}).formatToParts(now);
		const tzPart = parts.find(p => p.type === 'timeZoneName');
		const tzShort = tzPart?.value || '';

		// Compute the offset in hours between this tz and UTC.
		const localStr = now.toLocaleString('en-US', { timeZone: tz });
		const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
		const localTs = new Date(localStr).getTime();
		const utcTs = new Date(utcStr).getTime();
		const offsetHours = Math.round((localTs - utcTs) / 3600000);
		const sign = offsetHours >= 0 ? '+' : '';

		return tzShort ? `${tzShort}, UTC${sign}${offsetHours}` : `UTC${sign}${offsetHours}`;
	} catch {
		return tz;
	}
}

export { DEFAULT_TIMEZONE };
