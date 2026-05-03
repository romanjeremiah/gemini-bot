// All memory operations keyed by user_id (Telegram from.id), not chat_id.
// Each user has their own isolated memory space.

import * as vectorStore from './vectorStore';
import { log } from '../lib/logger';

const THERAPEUTIC_CATEGORIES = ['pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework'];

// Categories that should NEVER appear in chat prompts (any mode).
// Discoveries are deep-research findings — surface them via /researchhistory or
// the search_research tool when Roma asks. They are reference content, not
// conversation priming. Including them caused fabrication (e.g. "deep-dive into
// Japanese architecture you were pulling an all-nighter on").
const CHAT_FORBIDDEN_CATEGORIES = ['discovery'];

// What categories may be injected per register mode.
// 'default' (casual chat): identity + relationship + feedback + triples only.
// 'technical': adds architecture_spec + idea + brain_dump.
// 'warm':     adds full therapeutic stack.
const MODE_ALLOWED = {
	default: new Set(['identity', 'relationship', 'preference', 'personal', 'work', 'hobby', 'health', 'habit', 'feedback', 'triple']),
	technical: new Set(['identity', 'relationship', 'preference', 'personal', 'work', 'hobby', 'health', 'habit', 'feedback', 'triple', 'architecture_spec', 'idea', 'brain_dump']),
	warm: new Set(['identity', 'relationship', 'preference', 'personal', 'work', 'hobby', 'health', 'habit', 'feedback', 'triple', 'pattern', 'trigger', 'avoidance', 'schema', 'growth', 'coping', 'insight', 'homework']),
};

// Hard caps per mode per bucket. Keeps the prompt lean even when memory grows.
const MODE_CAPS = {
	default:   { factual: 8, feedback: 4, triples: 4, therapeutic: 0 },
	technical: { factual: 10, feedback: 4, triples: 6, therapeutic: 0 },
	warm:      { factual: 8, feedback: 4, triples: 8, therapeutic: 6 },
};

// Recency-weighted importance score. Old high-importance memories shouldn't
// drown out current state, and brand-new low-importance ones shouldn't beat
// stable identity facts. Half-life ~7 days.
function rankScore(memory) {
	const importance = Number(memory.importance_score) || 1;
	const created = new Date(memory.created_at + 'Z').getTime();
	const ageDays = Math.max(0, (Date.now() - created) / 86400000);
	return importance / (1 + ageDays / 7);
}

export async function saveMemory(env, userId, category, fact, importance = 1) {
	const cat = (category || 'general').toLowerCase();
	const factTrimmed = (fact || '').trim();
	if (!factTrimmed) return;

	// Ensure user_profiles entry exists (prevents FK constraint errors)
	await env.DB.prepare(
		'INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)'
	).bind(userId).run();

	// Save-time dedup: if a near-identical fact already exists in the same
	// category for this user, skip the insert and bump the existing row.
	// Uses two cheap layers before falling back to vector similarity:
	//   1. exact match (fast, catches the trigger 68/69 case)
	//   2. normalised prefix containment (catches "X." vs "X with extra detail")
	// Vector check is run only when those don't fire AND we have a Vectorize
	// binding — semantic dedup catches paraphrased duplicates like the four
	// "double exhaustion" patterns 56-59.
	try {
		const dupId = await findDuplicate(env, userId, cat, factTrimmed);
		if (dupId) {
			await env.DB.prepare(
				'UPDATE memories SET importance_score = MAX(importance_score, ?), created_at = CURRENT_TIMESTAMP WHERE id = ?'
			).bind(importance, dupId).run();
			log.info('memory_dedup_skipped', { userId, category: cat, dupId, factPreview: factTrimmed.slice(0, 80) });
			return;
		}
	} catch (e) {
		log.warn('memory_dedup_check_failed', { msg: e.message });
		// Fall through and insert anyway — better a duplicate than a lost memory.
	}

	const result = await env.DB.prepare(
		'INSERT INTO memories (user_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
	).bind(userId, cat, factTrimmed, importance).run();

	// Index in Vectorize for semantic search (fire-and-forget)
	const memoryId = result?.meta?.last_row_id || Date.now();
	vectorStore.indexMemory(env, userId, cat, factTrimmed, memoryId)
		.catch(e => console.error('Vectorize memory index error:', e.message));

	log.info('memory_saved', { userId, category: cat, memoryId, importance, factLen: factTrimmed.length });

	// Auto-consolidation trigger: when memory count crosses thresholds, kick
	// off background consolidation. Throttled via KV so we don't run it on
	// every save. Threshold: every 20 new memories above 40.
	try {
		const countRow = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM memories WHERE user_id = ?'
		).bind(userId).first();
		const total = countRow?.n || 0;
		if (total >= 40) {
			const lastRunKey = `memory_consolidation_last_${userId}`;
			const lastRun = await env.CHAT_KV.get(lastRunKey);
			const hoursSince = lastRun ? (Date.now() - parseInt(lastRun)) / 3600000 : Infinity;
			if (hoursSince > 24 && total % 20 === 0) {
				log.info('memory_consolidation_triggered', { userId, total });
				await env.CHAT_KV.put(lastRunKey, String(Date.now()), { expirationTtl: 86400 * 7 });
				// Fire-and-forget — consolidation is best-effort
				consolidateMemories(env, userId).catch(e =>
					log.error('memory_consolidation_async_failed', { msg: e.message })
				);
			}
		}
	} catch (e) {
		log.warn('memory_consolidation_check_failed', { msg: e.message });
	}
}

/**
 * Locate a duplicate of `fact` for this user+category. Returns the row id of
 * the duplicate, or null if none found. Three checks in cheap-to-expensive order.
 */
async function findDuplicate(env, userId, category, fact) {
	const factLower = fact.toLowerCase().trim();
	const factPrefix = factLower.slice(0, 120);

	// 1. Exact match (catches the 68/69 verbatim duplicate case)
	const exact = await env.DB.prepare(
		'SELECT id FROM memories WHERE user_id = ? AND category = ? AND LOWER(fact) = ? LIMIT 1'
	).bind(userId, category, factLower).first();
	if (exact?.id) return exact.id;

	// 2. Prefix containment — same opening 120 chars suggests near-duplicate
	const prefix = await env.DB.prepare(
		"SELECT id FROM memories WHERE user_id = ? AND category = ? AND LOWER(SUBSTR(fact, 1, 120)) = ? LIMIT 1"
	).bind(userId, category, factPrefix).first();
	if (prefix?.id) return prefix.id;

	// 3. Semantic dedup via Vectorize (only for therapeutic / pattern-shaped categories
	// where paraphrasing is common). Skipped for short factual items where exact/prefix
	// is enough.
	if (THERAPEUTIC_CATEGORIES.includes(category) && fact.length > 80 && env.VECTORIZE && env.AI) {
		try {
			const hits = await vectorStore.semanticSearch(env, userId, fact, 3, {
				categories: [category],
				minScore: 0.92,
			});
			if (hits?.length) {
				// metadata.memoryId is set by indexMemory — use it directly
				const dupRowId = Number(hits[0].metadata?.memoryId);
				if (Number.isFinite(dupRowId) && dupRowId > 0) return dupRowId;
			}
		} catch (e) {
			log.warn('memory_semantic_dedup_failed', { msg: e.message });
		}
	}

	return null;
}

export async function getMemories(env, userId, limit = 30) {
	const { results } = await env.DB.prepare(
		'SELECT id, category, fact, importance_score, created_at FROM memories WHERE user_id = ? ORDER BY importance_score DESC, created_at DESC LIMIT ?'
	).bind(userId, limit).all();
	return results || [];
}

export async function getMemoriesByCategory(env, userId, category, limit = 10) {
	const { results } = await env.DB.prepare(
		'SELECT id, category, fact, importance_score, created_at FROM memories WHERE user_id = ? AND category = ? ORDER BY created_at DESC LIMIT ?'
	).bind(userId, category.toLowerCase(), limit).all();
	return results || [];
}

/**
 * Build memCtx for a chat prompt, filtered by register mode.
 *
 * Replaces the previous behaviour of dumping all 40 most-important memories
 * into every prompt. Casual messages now get only stable identity/relationship
 * facts plus communication-preference feedback — no clinical history, no deep
 * research, no architecture specs. Therapeutic memories surface only when warm
 * register is active. Discovery memories never surface here — Roma's directive.
 *
 * @param {Object} env
 * @param {number} userId
 * @param {'default'|'technical'|'warm'} mode  Register-aware filter mode.
 * @returns {Promise<{ ctx: string, debug: Object }>}  ctx is the formatted text;
 *   debug contains counts per bucket so handlers.js can log what was injected.
 */
export async function getFormattedContext(env, userId, mode = 'default', userText = '') {
	const allowed = MODE_ALLOWED[mode] || MODE_ALLOWED.default;
	const caps = MODE_CAPS[mode] || MODE_CAPS.default;

	// Pull a wider window than we'll inject so the recency-weighted ranker has
	// something to choose from. Filter out forbidden categories at the SQL layer
	// to keep the working set small.
	const forbidden = CHAT_FORBIDDEN_CATEGORIES.map(c => `'${c}'`).join(',');
	const { results } = await env.DB.prepare(
		`SELECT id, category, fact, importance_score, created_at
		   FROM memories
		  WHERE user_id = ?
		    AND category NOT IN (${forbidden})
		  ORDER BY importance_score DESC, created_at DESC
		  LIMIT 60`
	).bind(userId).all();
	const all = results || [];

	if (!all.length) {
		return { ctx: '- No facts saved yet.', memories: [], debug: { mode, total: 0 } };
	}

	const therapeutic = [];
	const factual = [];
	const feedback = [];
	const triples = [];

	for (const m of all) {
		if (!allowed.has(m.category)) continue;
		if (THERAPEUTIC_CATEGORIES.includes(m.category)) therapeutic.push(m);
		else if (m.category === 'triple') triples.push(m);
		else if (m.category === 'feedback') feedback.push(m);
		else factual.push(m);
	}

	// Sort each bucket by recency-weighted importance, then truncate to cap.
	const sortAndCap = (arr, cap) => arr.sort((a, b) => rankScore(b) - rankScore(a)).slice(0, cap);

	const factualOut = sortAndCap(factual, caps.factual);
	const feedbackOut = sortAndCap(feedback, caps.feedback);
	const triplesOut = sortAndCap(triples, caps.triples);

	// Phase 5: semantic relevance gating for therapeutic memories in warm mode.
	// Casual chat (default mode) caps therapeutic at 0 anyway. Technical mode also.
	// Only warm mode injects therapeutic memories — and we want them to be
	// RELEVANT to the current message, not just recency-weighted top picks.
	//
	// Strategy:
	//   1. Always pin high-importance therapeutic memories (importance >= 2) so
	//      crisis-level patterns and safety schemas never get filtered out by
	//      a missed semantic match.
	//   2. For the remaining therapeutic slots, prefer semantic matches against
	//      the user's current message. Falls back to recency-weighted ranking
	//      if no userText is provided or the vector search fails.
	//
	// Without this, warm-mode injection drowned the prompt in week-old patterns
	// that had nothing to do with what the user just said — making Xaridotis
	// reply with stale clinical observations on unrelated topics.
	let therapeuticOut;
	if (mode === 'warm' && therapeutic.length > 0 && caps.therapeutic > 0) {
		const pinned = therapeutic.filter(m => Number(m.importance_score) >= 2);
		const pinnedIds = new Set(pinned.map(m => m.id));
		const remaining = therapeutic.filter(m => !pinnedIds.has(m.id));
		const remainingSlots = Math.max(0, caps.therapeutic - pinned.length);

		let semanticOrdered = remaining;
		if (userText && userText.length > 10 && remainingSlots > 0 && env.VECTORIZE && env.AI) {
			try {
				const hits = await vectorStore.semanticSearch(env, userId, userText, 20, {
					categories: THERAPEUTIC_CATEGORIES,
					minScore: 0.55,
				}).catch(() => []);
				const hitIds = new Set();
				for (const h of (hits || [])) {
					const rid = Number(h.metadata?.memoryId);
					if (Number.isFinite(rid) && rid > 0 && !pinnedIds.has(rid)) hitIds.add(rid);
				}
				if (hitIds.size > 0) {
					// Order remaining by: semantic-match first (in score order from hits),
					// then everything else by recency-weighted importance.
					const byId = new Map(remaining.map(m => [m.id, m]));
					const hitOrdered = [];
					for (const h of (hits || [])) {
						const rid = Number(h.metadata?.memoryId);
						const row = byId.get(rid);
						if (row) hitOrdered.push(row);
					}
					const nonHit = remaining.filter(m => !hitIds.has(m.id));
					nonHit.sort((a, b) => rankScore(b) - rankScore(a));
					semanticOrdered = [...hitOrdered, ...nonHit];
					log.info('therapeutic_semantic_filter', {
						userId,
						total_therapeutic: therapeutic.length,
						pinned: pinned.length,
						semantic_hits: hitIds.size,
						slots_remaining: remainingSlots,
					});
				}
			} catch (e) {
				log.warn('therapeutic_semantic_filter_failed', { msg: e.message });
			}
		}

		if (semanticOrdered === remaining) {
			// No semantic search ran or it failed — fall back to recency-weighted
			semanticOrdered = remaining.sort((a, b) => rankScore(b) - rankScore(a));
		}

		therapeuticOut = [...pinned, ...semanticOrdered.slice(0, remainingSlots)];
	} else {
		therapeuticOut = sortAndCap(therapeutic, caps.therapeutic);
	}

	let ctx = '';
	if (factualOut.length) {
		ctx += 'Facts about the user:\n';
		for (const m of factualOut) ctx += `- [${m.category}] ${m.fact}\n`;
	}
	if (therapeuticOut.length) {
		ctx += '\nTherapeutic observations:\n';
		for (const m of therapeuticOut) {
			ctx += `- [${m.category}] ${m.fact} (${getRelativeAge(m.created_at)})\n`;
		}
	}
	if (feedbackOut.length) {
		ctx += '\nLearned communication preferences (adapt accordingly):\n';
		for (const m of feedbackOut) ctx += `- ${m.fact}\n`;
	}
	if (triplesOut.length) {
		ctx += '\nKnowledge Graph (relational connections):\n';
		for (const m of triplesOut) ctx += `- ${m.fact}\n`;
	}

	return {
		ctx: ctx || '- No relevant facts for this context.',
		memories: [...factualOut, ...therapeuticOut, ...feedbackOut, ...triplesOut],
		debug: {
			mode,
			total: all.length,
			factual_kept: factualOut.length,
			therapeutic_kept: therapeuticOut.length,
			feedback_kept: feedbackOut.length,
			triples_kept: triplesOut.length,
			chars: ctx.length,
		},
	};
}

function getRelativeAge(dateStr) {
	const created = new Date(dateStr + 'Z');
	const now = new Date();
	const days = Math.floor((now - created) / 86400000);
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

export async function deleteAllMemories(env, userId) {
	await env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId).run();
}

export async function deleteMemoriesByCategory(env, userId, category) {
	await env.DB.prepare('DELETE FROM memories WHERE user_id = ? AND category = ?').bind(userId, category.toLowerCase()).run();
}

export async function getRecentTherapeuticMemories(env, userId, days = 7) {
	const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
	const { results } = await env.DB.prepare(`
		SELECT category, fact, importance_score, created_at
		FROM memories
		WHERE user_id = ?
		  AND category IN ('homework', 'coping', 'growth', 'idea', 'brain_dump', 'insight')
		  AND created_at > ?
		ORDER BY created_at DESC
		LIMIT 30
	`).bind(userId, since).all();
	return results || [];
}

export async function consolidateMemories(env, userId) {
	const allMemories = await getMemories(env, userId, 200);
	if (allMemories.length < 15) return;

	const { generateWithFallback } = await import('../lib/ai/gemini.js');
	const rawText = allMemories.map(m => `[id=${m.id}|${m.category}|imp=${m.importance_score}] ${m.fact}`).join('\n');

	// Stricter consolidation prompt. Prior version produced overly aggressive
	// merges (e.g. fabricated identity facts surviving because they had high
	// importance scores). New rules:
	//   - Preserve user-specific specifics verbatim (named people, dates,
	//     numbers, idiosyncratic phrasing). These ARE the value of the memory.
	//   - Only merge true duplicates and near-paraphrases.
	//   - Discard memories that have explicit expiry ("valid until DD/MM/YYYY")
	//     where the date has passed.
	//   - Do NOT invent new content. If unsure whether to merge, keep both.
	//   - Do NOT exceed the input count — consolidation only shrinks.
	const todayIso = new Date().toISOString().split('T')[0];
	const prompt = `You are deduplicating a user's memory store. Be CONSERVATIVE: when in doubt, keep the memory.

INPUT (${allMemories.length} memories):
${rawText}

TODAY: ${todayIso}

RULES:
1. Merge ONLY exact duplicates and clear paraphrases of the SAME fact. Do not merge two facts just because they share a topic.
2. Preserve all user-specific specifics verbatim: named people (Jordan, Natalia, Martin), exact dates, exact numbers, idiosyncratic phrasing the user themselves used.
3. When merging duplicates, keep the LONGEST/MOST DETAILED version, not the shortest summary.
4. Drop ONLY memories with explicit expiry that has clearly passed (e.g. "valid until 15/04/2026" when today is after that). Anything ambiguous, keep.
5. Preserve all therapeutic memories with importance >= 2. Only deduplicate them within their own category.
6. Do NOT invent new facts. Do NOT rewrite a fact into a more 'professional' or 'clean' version — preserve the user's voice.
7. Output count must be LESS THAN OR EQUAL to input count. Never expand.

Return ONLY a raw JSON array, no markdown:
[{"category":"preference","fact":"...","importance":1}]`;

	try {
		const { text } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: prompt }] }],
			{ temperature: 0.2 }
		);
		const arrayMatch = text.match(/\[[\s\S]*\]/);
		const cleaned = arrayMatch ? arrayMatch[0] : '[]';
		const consolidated = JSON.parse(cleaned);
		if (!Array.isArray(consolidated) || consolidated.length === 0) {
			log.warn('memory_consolidation_empty_result', { userId, inputCount: allMemories.length });
			return;
		}

		// Safety check: refuse to consolidate if the model wants to cut more
		// than 80% of memories. Suggests the prompt was misinterpreted or the
		// model fabricated a tiny replacement set.
		const cutRatio = 1 - (consolidated.length / allMemories.length);
		if (cutRatio > 0.8) {
			log.warn('memory_consolidation_too_aggressive', {
				userId,
				inputCount: allMemories.length,
				outputCount: consolidated.length,
				cutRatio: cutRatio.toFixed(2),
			});
			return;
		}

		// Capture the IDs about to be deleted so we can clean up Vectorize.
		const deletedIds = allMemories.map(m => m.id);

		const deleteStmt = env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId);
		const insertStmts = consolidated.map(m =>
			env.DB.prepare(
				'INSERT INTO memories (user_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
			).bind(userId, (m.category || 'general').toLowerCase(), m.fact, m.importance || 1)
		);
		const batchResult = await env.DB.batch([deleteStmt, ...insertStmts]);

		// Re-index the new memories in Vectorize (the old vector entries are now
		// orphaned). We can't easily delete the orphans by ID without iterating,
		// so we use a deterministic cleanup pattern: delete by ID for the ones
		// we have, then upsert the new ones.
		if (env.VECTORIZE && env.AI) {
			try {
				const orphanIds = deletedIds.map(id => `mem_${userId}_${id}`);
				// Vectorize supports deleteByIds. Fire-and-forget — if it fails,
				// the orphans will linger but won't surface (they're filtered
				// by userId on every query, and reranker discards them anyway).
				await env.VECTORIZE.deleteByIds(orphanIds).catch(e =>
					log.warn('vectorize_orphan_cleanup_failed', { msg: e.message })
				);

				// Re-index new memories. Pull the freshly inserted rows so we have
				// the new memoryIds (the inserts above don't return IDs through batch).
				const { results: freshRows } = await env.DB.prepare(
					'SELECT id, category, fact FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?'
				).bind(userId, consolidated.length).all();
				for (const row of (freshRows || [])) {
					vectorStore.indexMemory(env, userId, row.category, row.fact, row.id)
						.catch(e => log.warn('vectorize_reindex_failed', { msg: e.message }));
				}
			} catch (e) {
				log.warn('vectorize_consolidation_cleanup_failed', { msg: e.message });
			}
		}

		log.info('memory_consolidated', {
			userId,
			before: allMemories.length,
			after: consolidated.length,
			reduction_pct: Math.round((1 - consolidated.length / allMemories.length) * 100),
		});
		console.log(`🧠 Consolidated ${allMemories.length} → ${consolidated.length} memories (batched)`);
		await env.DB.exec('PRAGMA optimize;');
	} catch (e) {
		console.error('Memory consolidation failed:', e.message);
		log.error('memory_consolidation_failed', { userId, msg: e.message });
	}
}
