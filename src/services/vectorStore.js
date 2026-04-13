/**
 * Vectorize Semantic Memory Service
 * Uses Cloudflare Workers AI for embeddings + Vectorize for semantic search.
 * Enhances the existing memoryStore with fuzzy "find conversations about topic X" capability.
 *
 * Embedding model: @cf/baai/bge-base-en-v1.5 (768 dimensions, cosine metric)
 * Reranker: @cf/baai/bge-reranker-base (cross-attention relevance scoring)
 */

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const RERANKER_MODEL = '@cf/baai/bge-reranker-base';
const MAX_TEXT_LENGTH = 512; // bge-base-en-v1.5 context window

/**
 * Generate embedding for a text string using Workers AI.
 * @param {Object} env - Worker env with AI binding
 * @param {string} text
 * @returns {Float32Array|number[]} 768-dim vector
 */
async function embed(env, text) {
	const truncated = text.slice(0, MAX_TEXT_LENGTH);
	const result = await env.AI.run(EMBEDDING_MODEL, { text: [truncated] });
	return result.data[0];
}

/**
 * Rerank search results using cross-attention for higher precision.
 * Takes Vectorize results and re-scores them against the original query.
 * @param {Object} env - Worker env with AI binding
 * @param {string} query - the user's message
 * @param {Array} results - Vectorize search results with metadata
 * @returns {Array} reranked results sorted by relevance
 */
async function rerank(env, query, results) {
	if (!env.AI || !results.length) return results;
	try {
		const documents = results.map(r => r.metadata?.fact || r.metadata?.preview || '').filter(Boolean);
		if (!documents.length) return results;

		const reranked = await env.AI.run(RERANKER_MODEL, { query, documents });
		if (!reranked?.data?.length) return results;

		// Map reranker scores back to original results
		const scored = reranked.data
			.map((item, idx) => ({ ...results[idx], rerankerScore: item.score }))
			.sort((a, b) => b.rerankerScore - a.rerankerScore);

		return scored;
	} catch (err) {
		console.error('⚠️ Reranker error:', err.message);
		return results; // Fallback to original Vectorize ordering
	}
}

/**
 * Store a memory with its vector embedding for semantic search.
 * Call this alongside memoryStore.saveMemory() to index the fact.
 *
 * @param {Object} env - Worker env with VECTORIZE + AI bindings
 * @param {number} chatId
 * @param {string} category
 * @param {string} fact - the memory text to embed
 * @param {string|number} memoryId - DB row ID or unique key
 */
export async function indexMemory(env, chatId, category, fact, memoryId) {
	if (!env.VECTORIZE || !env.AI) {
		console.log('⚠️ Vectorize/AI not bound — skipping semantic indexing');
		return;
	}
	try {
		const vector = await embed(env, fact);
		await env.VECTORIZE.upsert([{
			id: `mem_${chatId}_${memoryId}`,
			values: vector,
			metadata: {
				chatId: Number(chatId),
				category,
				fact: fact.slice(0, 200), // store truncated fact in metadata for quick retrieval
				memoryId: String(memoryId),
			},
		}]);
		console.log(`🧠 Vectorize indexed: mem_${chatId}_${memoryId}`);
	} catch (err) {
		console.error('⚠️ Vectorize index error:', err.message);
	}
}

/**
 * Index a conversation turn for later semantic retrieval.
 * Useful for "what did we talk about X?" queries.
 *
 * @param {Object} env
 * @param {number} chatId
 * @param {string} userText - what the user said
 * @param {string} aiSummary - brief AI response summary (first 200 chars)
 * @param {number} messageId - Telegram message ID
 */
export async function indexConversation(env, chatId, userText, aiSummary, messageId) {
	if (!env.VECTORIZE || !env.AI) return;
	try {
		const combined = `User: ${userText}\nAI: ${aiSummary}`;
		const vector = await embed(env, combined);
		const timestamp = Math.floor(Date.now() / 1000);
		await env.VECTORIZE.upsert([{
			id: `conv_${chatId}_${messageId}`,
			values: vector,
			metadata: {
				chatId: Number(chatId),
				type: 'conversation',
				preview: combined.slice(0, 200),
				timestamp,
				messageId,
			},
		}]);
	} catch (err) {
		// Non-critical — don't break the conversation flow
		console.error('⚠️ Vectorize conversation index error:', err.message);
	}
}

/**
 * Semantic search across memories and conversations for a given chat.
 *
 * @param {Object} env
 * @param {number} chatId
 * @param {string} query - natural language query
 * @param {number} topK - max results (default 5)
 * @param {Object} opts - options: { categories: string[], minScore: number }
 * @returns {Array<{ id: string, score: number, metadata: Object }>}
 */
export async function semanticSearch(env, chatId, query, topK = 5, opts = {}) {
	if (!env.VECTORIZE || !env.AI) {
		console.log('⚠️ Vectorize/AI not bound — semantic search unavailable');
		return [];
	}
	try {
		const vector = await embed(env, query);
		const filter = { chatId: { $eq: Number(chatId) } };

		// Use $in for multi-category filtering (e.g. all therapeutic categories at once)
		if (opts.categories?.length) {
			filter.category = { $in: opts.categories };
		}

		const results = await env.VECTORIZE.query(vector, {
			topK,
			filter,
			returnMetadata: 'all',
		});

		const minScore = opts.minScore || 0;
		return (results.matches || [])
			.filter(m => m.score >= minScore)
			.map(m => ({
				id: m.id,
				score: m.score,
				metadata: m.metadata,
			}));
	} catch (err) {
		console.error('⚠️ Vectorize search error:', err.message);
		return [];
	}
}

/**
 * Search specifically across therapeutic memories (triggers, schemas, patterns, avoidance, growth).
 * Uses $in filter to sweep all clinical categories in a single query.
 */
export async function therapeuticSearch(env, chatId, query, topK = 5) {
	return semanticSearch(env, chatId, query, topK, {
		categories: ['trigger', 'schema', 'avoidance', 'pattern', 'growth', 'coping', 'insight', 'homework'],
		minScore: 0.6,
	});
}

/**
 * Search specifically across learning/discovery memories.
 */
export async function knowledgeSearch(env, chatId, query, topK = 5) {
	return semanticSearch(env, chatId, query, topK, {
		categories: ['discovery', 'growth'],
		minScore: 0.5,
	});
}

/**
 * Delete all vectors for a chat (call when user does /forget).
 */
export async function deleteAllVectors(env, chatId) {
	if (!env.VECTORIZE) return;
	try {
		// Vectorize V2 supports deleteByFilter (if available), otherwise we query + delete
		// For now, query all and delete by IDs
		const dummyVector = new Array(768).fill(0);
		const results = await env.VECTORIZE.query(dummyVector, {
			topK: 1000,
			filter: { chatId: { $eq: Number(chatId) } },
			returnMetadata: 'none',
		});
		const ids = (results.matches || []).map(m => m.id);
		if (ids.length) {
			await env.VECTORIZE.deleteByIds(ids);
			console.log(`🧠 Vectorize deleted ${ids.length} vectors for chat ${chatId}`);
		}
	} catch (err) {
		console.error('⚠️ Vectorize bulk delete error:', err.message);
	}
}

/**
 * Build a semantic context string for the system prompt.
 * Given the user's current message, find relevant past memories/conversations.
 *
 * @param {Object} env
 * @param {number} chatId
 * @param {string} userMessage
 * @returns {string} formatted context or empty string
 */
export async function getSemanticContext(env, chatId, userMessage) {
	if (!env.VECTORIZE || !env.AI) return '';
	if (!userMessage || userMessage.length < 5) return '';

	try {
		// Run two searches in parallel: general recall + therapeutic pattern matching
		const [generalResults, therapeuticResults] = await Promise.all([
			semanticSearch(env, chatId, userMessage, 3, { minScore: 0.65 }),
			therapeuticSearch(env, chatId, userMessage, 3),
		]);

		// Deduplicate by ID
		const seen = new Set();
		const allResults = [];
		for (const r of [...therapeuticResults, ...generalResults]) {
			if (!seen.has(r.id)) {
				seen.add(r.id);
				allResults.push(r);
			}
		}

		if (!allResults.length) return '';

		// Rerank: use cross-attention model to find the most precisely relevant results
		const reranked = await rerank(env, userMessage, allResults);
		const topResults = reranked.slice(0, 5);

		let ctx = '\nSemantic recall (related past context):\n';
		let criticalAlert = '';

		for (const r of topResults) {
			const meta = r.metadata;
			const relevance = r.rerankerScore != null ? `rerank: ${(r.rerankerScore * 100).toFixed(0)}%` : `${(r.score * 100).toFixed(0)}%`;
			if (meta.fact) {
				ctx += `- [${meta.category}] ${meta.fact} (${relevance})\n`;

				// TRIGGER INTERCEPTION: if the message strongly matches a known trigger, schema, or avoidance pattern
				const isHighRelevance = (r.rerankerScore != null ? r.rerankerScore > 0.8 : r.score > 0.75);
				if (isHighRelevance && ['trigger', 'schema', 'avoidance'].includes(meta.category)) {
					criticalAlert += `\nCLINICAL ALERT: The user's current message strongly matches a known ${meta.category.toUpperCase()}: "${meta.fact}". Adjust your response to gently deploy coping strategies, validate the trigger, or explore this schema with care. Do not ignore this context.\n`;
				}
			} else if (meta.preview) {
				ctx += `- Past conversation: ${meta.preview} (${relevance})\n`;
			}
		}
		return criticalAlert + ctx;
	} catch (err) {
		console.error('⚠️ Semantic context error:', err.message);
		return '';
	}
}
