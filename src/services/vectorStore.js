/**
 * Vectorize Semantic Memory Service
 * Uses Gemini Embedding 2 for multimodal embeddings + Cloudflare Vectorize for search.
 * Supports text, images, audio, video, and documents in a unified embedding space.
 *
 * Primary embedding: gemini-embedding-2-preview (768 dimensions via output_dimensionality)
 * Fallback embedding: @cf/baai/bge-base-en-v1.5 (768 dimensions, text-only)
 * Reranker: @cf/baai/bge-reranker-base (cross-attention relevance scoring)
 */

const FALLBACK_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const RERANKER_MODEL = '@cf/baai/bge-reranker-base';
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2-preview';
const EMBEDDING_DIMS = 768;
const MAX_TEXT_LENGTH = 8000; // Gemini Embedding 2 supports 8192 tokens

/**
 * Generate embedding using Gemini Embedding 2 (multimodal).
 * Falls back to Cloudflare Workers AI for text if Gemini is unavailable.
 * @param {Object} env - Worker env with AI + GEMINI_API_KEY
 * @param {string|Object} input - text string or { inlineData: { mimeType, data } } for media
 * @returns {number[]} 768-dim vector
 */
async function embed(env, input) {
	// Try Gemini Embedding 2 first (supports multimodal)
	if (env.GEMINI_API_KEY) {
		try {
			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

			let content;
			if (typeof input === 'string') {
				content = input.slice(0, MAX_TEXT_LENGTH);
			} else if (input?.inlineData) {
				// Multimodal: image/audio/video as inline data
				content = [input];
			} else {
				content = String(input).slice(0, MAX_TEXT_LENGTH);
			}

			const result = await ai.models.embedContent({
				model: GEMINI_EMBEDDING_MODEL,
				contents: content,
				config: { outputDimensionality: EMBEDDING_DIMS },
			});

			return result.embeddings?.[0]?.values || result.embedding?.values;
		} catch (err) {
			console.warn('⚠️ Gemini Embedding 2 failed, falling back to Workers AI:', err.message);
		}
	}

	// Fallback: Cloudflare Workers AI (text-only)
	if (typeof input !== 'string') {
		console.warn('⚠️ Non-text input requires Gemini Embedding 2, skipping');
		return null;
	}
	const truncated = input.slice(0, 512);
	const result = await env.AI.run(FALLBACK_EMBEDDING_MODEL, { text: [truncated] });
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
	if (!env.AI || !results.length || !query?.trim()) return results;
	try {
		// Build contexts + track which original results they map to
		const validPairs = [];
		for (let i = 0; i < results.length; i++) {
			const text = (results[i].metadata?.fact || results[i].metadata?.preview || '').trim();
			if (text.length >= 3) validPairs.push({ idx: i, text });
		}
		if (!validPairs.length) return results;

		const cleanQuery = query.trim().slice(0, 512);
		if (cleanQuery.length < 2) return results;

		const contexts = validPairs.map(p => p.text);
		const reranked = await env.AI.run(RERANKER_MODEL, { query: cleanQuery, contexts });
		if (!reranked?.data?.length) return results;

		// Map reranker scores back to original results via tracked indices
		const scored = reranked.data
			.map((item, i) => {
				const originalIdx = validPairs[i]?.idx;
				if (originalIdx == null || !results[originalIdx]) return null;
				return { ...results[originalIdx], rerankerScore: item.score };
			})
			.filter(Boolean)
			.sort((a, b) => b.rerankerScore - a.rerankerScore);

		return scored;
	} catch (err) {
		console.error('⚠️ Reranker error:', err.message);
		return results;
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
 * Index media (images, audio, video) for multimodal semantic search.
 * Uses Gemini Embedding 2 to embed the media directly.
 * @param {Object} env
 * @param {number} chatId
 * @param {string} mediaType - 'image', 'audio', 'video'
 * @param {string} base64Data - base64-encoded media content
 * @param {string} mimeType - e.g. 'image/jpeg', 'audio/ogg'
 * @param {string} description - AI-generated description of the media
 * @param {number} messageId - Telegram message ID for reference
 */
export async function indexMedia(env, chatId, mediaType, base64Data, mimeType, description, messageId) {
	if (!env.VECTORIZE || !env.GEMINI_API_KEY) return;
	try {
		const vector = await embed(env, { inlineData: { mimeType, data: base64Data } });
		if (!vector) return;

		await env.VECTORIZE.upsert([{
			id: `media_${chatId}_${messageId}`,
			values: vector,
			metadata: {
				chatId: Number(chatId),
				category: mediaType,
				fact: `[${mediaType}] ${description || 'Media attachment'}`.slice(0, 200),
				messageId: String(messageId),
				mediaType,
			},
		}]);
		console.log(`🖼️ Vectorize indexed media: ${mediaType} (msg ${messageId})`);
	} catch (err) {
		console.error('⚠️ Vectorize media index error:', err.message);
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
