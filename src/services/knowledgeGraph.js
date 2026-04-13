/**
 * Knowledge Graph Service — GraphRAG for Xaridotis
 *
 * Stores relationships as Subject-Predicate-Object triples in D1.
 * Enables relational reasoning: "Roman likes coffee" + "coffee is stimulant"
 * = "Roman may be overstimulated when anxious."
 *
 * Populated by: silentObservation (background), memory consolidation (cron)
 * Queried by: message handler (emotional context), mood check-ins
 */

/**
 * Save a triple to the knowledge graph.
 */
export async function saveTriple(env, chatId, subject, predicate, object, context = null, source = 'observation') {
	// Deduplicate: don't insert if this exact triple exists
	const existing = await env.DB.prepare(
		`SELECT id FROM knowledge_graph WHERE chat_id = ? AND subject = ? AND predicate = ? AND object = ? LIMIT 1`
	).bind(chatId, subject, predicate, object).first();
	if (existing) return existing.id;

	const { meta } = await env.DB.prepare(
		`INSERT INTO knowledge_graph (chat_id, subject, predicate, object, context, source) VALUES (?, ?, ?, ?, ?, ?)`
	).bind(chatId, subject, predicate, object, context, source).run();
	return meta.last_row_id;
}


/**
 * Query triples by subject — "What do we know about X?"
 */
export async function queryBySubject(env, chatId, subject, limit = 10) {
	const { results } = await env.DB.prepare(
		`SELECT * FROM knowledge_graph WHERE chat_id = ? AND subject LIKE ? ORDER BY created_at DESC LIMIT ?`
	).bind(chatId, `%${subject}%`, limit).all();
	return results || [];
}

/**
 * Query triples by object — "What relates to X?"
 */
export async function queryByObject(env, chatId, object, limit = 10) {
	const { results } = await env.DB.prepare(
		`SELECT * FROM knowledge_graph WHERE chat_id = ? AND object LIKE ? ORDER BY created_at DESC LIMIT ?`
	).bind(chatId, `%${object}%`, limit).all();
	return results || [];
}

/**
 * Query triples involving a concept (as subject OR object).
 * This is the main retrieval function for GraphRAG.
 */
export async function queryRelated(env, chatId, concept, limit = 15) {
	const safe = concept.replace(/[%_\\'";\n\r]/g, '').slice(0, 50);
	const { results } = await env.DB.prepare(
		`SELECT * FROM knowledge_graph WHERE chat_id = ? AND (subject LIKE ? OR object LIKE ?)
		ORDER BY confidence DESC, created_at DESC LIMIT ?`
	).bind(chatId, `%${safe}%`, `%${safe}%`, limit).all();
	return results || [];
}

/**
 * Multi-hop query: find connections between two concepts.
 * e.g., "How does coffee relate to sleep?" finds:
 * Roman → drinks → coffee, coffee → is → stimulant, stimulant → disrupts → sleep
 */
export async function findPath(env, chatId, conceptA, conceptB, maxHops = 2) {
	const safeA = conceptA.replace(/[%_\\'";\n\r]/g, '').slice(0, 30);
	const safeB = conceptB.replace(/[%_\\'";\n\r]/g, '').slice(0, 30);

	// Hop 1: direct connections from A
	const fromA = await queryRelated(env, chatId, safeA, 20);

	// Check for direct connection to B
	const direct = fromA.filter(t =>
		t.object?.toLowerCase().includes(safeB.toLowerCase()) ||
		t.subject?.toLowerCase().includes(safeB.toLowerCase())
	);
	if (direct.length) return direct;

	if (maxHops < 2) return [];

	// Hop 2: follow objects from A and see if they connect to B
	const intermediates = [...new Set(fromA.map(t => t.object))];
	for (const mid of intermediates.slice(0, 5)) {
		const hop2 = await queryRelated(env, chatId, mid, 10);
		const found = hop2.filter(t =>
			t.object?.toLowerCase().includes(safeB.toLowerCase()) ||
			t.subject?.toLowerCase().includes(safeB.toLowerCase())
		);
		if (found.length) {
			const connecting = fromA.filter(t => t.object === mid);
			return [...connecting, ...found];
		}
	}
	return [];
}

/**
 * Format knowledge graph results for Gemini context injection.
 */
export function formatGraphContext(triples, maxLen = 1500) {
	if (!triples.length) return '';
	let ctx = 'KNOWLEDGE GRAPH (relational facts):\n';
	for (const t of triples) {
		const line = `${t.subject} → ${t.predicate} → ${t.object}${t.context ? ` (${t.context})` : ''}\n`;
		if (ctx.length + line.length > maxLen) break;
		ctx += line;
	}
	return ctx;
}
