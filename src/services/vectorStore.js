/**
 * Vectorize Semantic Memory Service
 * Uses Cloudflare Workers AI for embeddings + Vectorize for semantic search.
 * Enhances the existing memoryStore with fuzzy "find conversations about topic X" capability.
 *
 * Embedding model: @cf/baai/bge-base-en-v1.5 (768 dimensions, cosine metric)
 */

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
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
 * @param {string|null} type - filter: 'memory' | 'conversation' | null (both)
 * @returns {Array<{ id: string, score: number, metadata: Object }>}
 */
export async function semanticSearch(env, chatId, query, topK = 5, type = null) {
	if (!env.VECTORIZE || !env.AI) {
		console.log('⚠️ Vectorize/AI not bound — semantic search unavailable');
		return [];
	}
	try {
		const vector = await embed(env, query);
		const filter = { chatId: Number(chatId) };
		if (type === 'memory') filter.category = { $ne: undefined };
		if (type === 'conversation') filter.type = 'conversation';

		const results = await env.VECTORIZE.query(vector, {
			topK,
			filter: { chatId: { $eq: Number(chatId) } },
			returnMetadata: 'all',
		});

		return (results.matches || []).map(m => ({
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
		const results = await semanticSearch(env, chatId, userMessage, 3);
		if (!results.length) return '';

		const relevant = results.filter(r => r.score > 0.65);
		if (!relevant.length) return '';

		let ctx = '\nSemantic recall (related past context):\n';
		let criticalAlert = '';

		for (const r of relevant) {
			const meta = r.metadata;
			if (meta.fact) {
				ctx += `- [${meta.category}] ${meta.fact} (relevance: ${(r.score * 100).toFixed(0)}%)\n`;

				// TRIGGER INTERCEPTION: if the message strongly matches a known trigger, schema, or avoidance pattern
				if (r.score > 0.75 && ['trigger', 'schema', 'avoidance'].includes(meta.category)) {
					criticalAlert += `\nCLINICAL ALERT: The user's current message strongly matches a known ${meta.category.toUpperCase()}: "${meta.fact}". Adjust your response to gently deploy coping strategies, validate the trigger, or explore this schema with care. Do not ignore this context.\n`;
				}
			} else if (meta.preview) {
				ctx += `- Past conversation: ${meta.preview} (relevance: ${(r.score * 100).toFixed(0)}%)\n`;
			}
		}
		return criticalAlert + ctx;
	} catch (err) {
		console.error('⚠️ Semantic context error:', err.message);
		return '';
	}
}
