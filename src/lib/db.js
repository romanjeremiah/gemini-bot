/**
 * Database Utilities — centralised D1 query helpers.
 *
 * THE RULE: Never pass raw user input into a LIKE pattern.
 * Always use safeLike() to sanitise search terms.
 *
 * D1's LIKE operator chokes on:
 * - Special chars: % _ ' " ; ( ) [ ] { } < > ! @ # $ ^ & * + = | ~ `
 * - Long patterns (>50 chars)
 * - Unicode edge cases
 *
 * This module provides a single utility that every service/tool
 * should use when building LIKE queries.
 */

/**
 * Sanitise a string for safe use in D1 LIKE patterns.
 * Strips all non-alphanumeric characters, limits to maxWords words.
 *
 * Usage:
 *   const safe = safeLike(userInput);
 *   db.prepare(`SELECT * FROM t WHERE col LIKE ?`).bind(`%${safe}%`).all();
 *
 * @param {string} input - Raw user input
 * @param {number} maxWords - Maximum words to keep (default 4)
 * @returns {string} Sanitised string safe for LIKE patterns
 */
export function safeLike(input, maxWords = 4) {
	if (!input) return '';
	return input
		.replace(/[^a-zA-Z0-9\s]/g, '')  // Only keep letters, numbers, spaces
		.trim()
		.split(/\s+/)
		.slice(0, maxWords)
		.join(' ');
}

/**
 * Wrap a D1 database instance so that every failed query logs the
 * exact SQL text and bindings that triggered the error.
 *
 * Non-invasive: query results are unchanged, only errors get extra logging.
 *
 * Usage (at env boundary, e.g. index.js webhook handler):
 *   env.DB = wrapD1(env.DB);
 *
 * @param {D1Database} db
 * @returns {D1Database} A proxied instance that logs SQL on error
 */
export function wrapD1(db) {
	if (!db || db.__wrapped) return db;

	const wrapped = new Proxy(db, {
		get(target, prop) {
			if (prop === '__wrapped') return true;
			const value = target[prop];
			if (prop === 'prepare') {
				return (sql) => {
					const stmt = value.call(target, sql);
					return wrapStmt(stmt, sql);
				};
			}
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return wrapped;
}

function wrapStmt(stmt, sql, binds = []) {
	return new Proxy(stmt, {
		get(target, prop) {
			const value = target[prop];
			if (prop === 'bind') {
				return (...args) => {
					const bound = value.apply(target, args);
					return wrapStmt(bound, sql, args);
				};
			}
			if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
				return async (...args) => {
					for (let attempt = 0; attempt < 2; attempt++) {
						try {
							return await value.apply(target, args);
						} catch (err) {
							const msg = err?.message || '';
							const isTransient = msg.includes('storage operation exceeded timeout')
								|| msg.includes('Network connection lost')
								|| msg.includes('internal error')
								|| msg.includes('object to be reset')
								|| msg.includes('transient issue');
							if (attempt === 0 && isTransient) {
								console.warn('[D1_RETRY]', { sql: sql?.replace(/\s+/g, ' ').trim().slice(0, 200), attempt: attempt + 1 });
								await new Promise(r => setTimeout(r, 500));
								continue;
							}
							console.error('[D1_QUERY_ERROR]', {
								sql: sql?.replace(/\s+/g, ' ').trim().slice(0, 500),
								binds: binds.map(b => typeof b === 'string' ? b.slice(0, 80) : b),
								method: prop,
								message: err?.message,
							});
							throw err;
						}
					}
				};
			}
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}
