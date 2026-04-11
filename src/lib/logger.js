// Structured Logger for Cloudflare Workers
// Outputs JSON lines compatible with wrangler tail and Workers Logs dashboard.
// Usage: log.info('message', { key: value }) or log.error('message', { error: e.message })

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const MIN_LEVEL = LEVELS.info; // Change to 'debug' for verbose logging

function emit(level, msg, data = {}) {
	if (LEVELS[level] < MIN_LEVEL) return;
	const entry = { ts: new Date().toISOString(), level, msg, ...data };
	if (level === 'error' || level === 'fatal') {
		console.error(JSON.stringify(entry));
	} else if (level === 'warn') {
		console.warn(JSON.stringify(entry));
	} else {
		console.log(JSON.stringify(entry));
	}
}

export const log = {
	debug: (msg, data) => emit('debug', msg, data),
	info: (msg, data) => emit('info', msg, data),
	warn: (msg, data) => emit('warn', msg, data),
	error: (msg, data) => emit('error', msg, data),
	fatal: (msg, data) => emit('fatal', msg, data),
};
