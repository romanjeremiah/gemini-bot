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
