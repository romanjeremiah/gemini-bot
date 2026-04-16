/**
 * Knowledge Graph Service — GraphRAG
 * All data keyed by user_id for per-user isolation.
 */

import { safeLike } from '../lib/db';

export async function saveTriple(env, userId, subject, predicate, object, context = null, source = 'observation') {
	const existing = await env.DB.prepare(
		'SELECT id FROM knowledge_graph WHERE user_id = ? AND subject = ? AND predicate = ? AND object = ? LIMIT 1'
	).bind(userId, subject, predicate, object).first();
	if (existing) return existing.id;

	const { meta } = await env.DB.prepare(
		'INSERT INTO knowledge_graph (user_id, subject, predicate, object, context, source) VALUES (?, ?, ?, ?, ?, ?)'
	).bind(userId, subject, predicate, object, context, source).run();
	return meta.last_row_id;
}

export async function queryBySubject(env, userId, subject, limit = 10) {
	const safe = safeLike(subject);
	if (!safe) return [];
	const { results } = await env.DB.prepare(
		'SELECT * FROM knowledge_graph WHERE user_id = ? AND subject LIKE ? ORDER BY created_at DESC LIMIT ?'
	).bind(userId, `%${safe}%`, limit).all();
	return results || [];
}

export async function queryByObject(env, userId, object, limit = 10) {
	const safe = safeLike(object);
	if (!safe) return [];
	const { results } = await env.DB.prepare(
		'SELECT * FROM knowledge_graph WHERE user_id = ? AND object LIKE ? ORDER BY created_at DESC LIMIT ?'
	).bind(userId, `%${safe}%`, limit).all();
	return results || [];
}

export async function queryRelated(env, userId, concept, limit = 15) {
	const safe = safeLike(concept);
	if (!safe) return [];
	const p = `%${safe}%`;
	const { results } = await env.DB.prepare(
		'SELECT * FROM knowledge_graph WHERE user_id = ? AND (subject LIKE ? OR object LIKE ?) ORDER BY confidence DESC, created_at DESC LIMIT ?'
	).bind(userId, p, p, limit).all();
	return results || [];
}

export async function findPath(env, userId, conceptA, conceptB, maxHops = 2) {
	const fromA = await queryRelated(env, userId, conceptA, 20);
	const bLower = conceptB.toLowerCase();
	const direct = fromA.filter(t =>
		t.object?.toLowerCase().includes(bLower) || t.subject?.toLowerCase().includes(bLower)
	);
	if (direct.length) return direct;
	if (maxHops < 2) return [];

	const intermediates = [...new Set(fromA.map(t => t.object))];
	for (const mid of intermediates.slice(0, 5)) {
		const hop2 = await queryRelated(env, userId, mid, 10);
		const found = hop2.filter(t =>
			t.object?.toLowerCase().includes(bLower) || t.subject?.toLowerCase().includes(bLower)
		);
		if (found.length) {
			const connecting = fromA.filter(t => t.object === mid);
			return [...connecting, ...found];
		}
	}
	return [];
}

export function formatGraphContext(triples, maxLen = 1500) {
	if (!triples.length) return '';
	let ctx = 'KNOWLEDGE GRAPH (relational facts):\n';
	for (const t of triples) {
		const line = `${t.subject} -> ${t.predicate} -> ${t.object}${t.context ? ` (${t.context})` : ''}\n`;
		if (ctx.length + line.length > maxLen) break;
		ctx += line;
	}
	return ctx;
}
