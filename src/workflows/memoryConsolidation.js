import { WorkflowEntrypoint } from 'cloudflare:workers';

/**
 * Memory Consolidation Workflow ("REM Sleep")
 *
 * A durable, multi-step workflow that consolidates memories monthly.
 * Each step is independently retryable and persists state between steps.
 * If the AI call times out or D1 is slow, the workflow pauses and retries
 * automatically without restarting from scratch.
 */
export class MemoryConsolidationWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const chatId = event.payload?.chatId;
		const userId = event.payload?.userId || chatId;
		if (!userId) throw new Error('Missing userId/chatId in workflow payload');

		// Step 1: Fetch all memories from D1
		const allMemories = await step.do('fetch-memories', async () => {
			const { results } = await this.env.DB.prepare(
				'SELECT id, category, fact, importance_score, created_at FROM memories WHERE user_id = ? ORDER BY importance_score DESC, created_at DESC LIMIT 200'
			).bind(userId).all();
			return results || [];
		});

		if (allMemories.length < 15) {
			return { status: 'skipped', reason: 'Not enough memories to consolidate', count: allMemories.length };
		}

		// Step 2: First-pass deduplication using Cloudflare AI (free, saves Gemini tokens)
		const dedupResult = await step.do('cf-ai-dedup', {
			retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
			timeout: '30 seconds',
		}, async () => {
			try {
				const { deduplicateMemories } = await import('../services/cfAi');
				return await deduplicateMemories(this.env, allMemories);
			} catch (e) {
				console.error('CF AI dedup failed, skipping:', e.message);
				return { groups: [], duplicates: [] };
			}
		});

		// Remove duplicates and contradicted (older) memories identified by CF AI
		const removeIds = new Set();
		for (const [, dupIdx] of dedupResult.duplicates) {
			if (allMemories[dupIdx]) removeIds.add(allMemories[dupIdx].id);
		}
		// Contradictions: [olderIdx, newerIdx] — remove the older one
		for (const [olderIdx] of (dedupResult.contradictions || [])) {
			if (allMemories[olderIdx]) removeIds.add(allMemories[olderIdx].id);
		}
		const dedupedMemories = allMemories.filter(m => !removeIds.has(m.id));
		console.log(`🧹 CF AI dedup: ${allMemories.length} → ${dedupedMemories.length} memories (removed ${removeIds.size} duplicates/contradictions)`);

		// Step 3: Consolidate memories using CF AI (GLM-4.7-Flash — 131K context, free)
		// Previously used Gemini Pro for this, but consolidation is summarisation,
		// not therapeutic reasoning. GLM-4.7-Flash handles it well and saves Gemini tokens.
		const consolidated = await step.do('ai-consolidation', {
			retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
			timeout: '120 seconds',
		}, async () => {
			const rawText = dedupedMemories.map(m =>
				`[${m.category}] ${m.fact} (Score: ${m.importance_score}, Date: ${m.created_at})`
			).join('\n');

			const prompt = `You are performing memory consolidation for a therapeutic Second Brain.
Here are the user's saved memories (sorted by importance, then date):
${rawText}

CONSOLIDATION RULES:

1. CONTRADICTIONS: When two memories contradict each other, KEEP ONLY THE NEWER ONE.
   Example: "[preference] User likes coffee (Date: 2026-01)" vs "[preference] User switched to tea (Date: 2026-03)"
   → Keep only: "User switched to tea"
   For each contradiction you resolve, add a note: "(updated: was previously X)"

2. DUPLICATES: Remove exact or near-exact duplicates. Keep the version with more detail.

3. EVOLUTION: When a pattern has evolved over time, merge into ONE entry that captures the current state.
   Example: "User avoids difficult conversations" + "User successfully confronted Jordan instead of freezing"
   → Merge: "User historically avoided difficult conversations but has shown growing capacity to confront issues directly (e.g. successful confrontation with Jordan)."

4. CRITICAL PRESERVATION: Memories with importance score 3 must keep their exact wording.
   Never paraphrase or merge these — they capture precise therapeutic language.

5. CATEGORIES: Preserve the original category. Valid categories:
   identity, preference, pattern, growth, discovery, personal, feedback, research_ref, architecture_spec

6. IMPORTANCE SCORES: Keep original scores. If merging two memories, use the higher score.

Return ONLY a raw JSON array:
[{"category":"preference","fact":"...","importance":1}]
No markdown, no backticks. Just the array.`;

			// Try CF AI first (free, 131K context), fall back to Gemini Pro if it fails
			let text = '';
			try {
				const result = await this.env.AI.run('@cf/zai-org/glm-4.7-flash', {
					messages: [
						{ role: 'system', content: 'You consolidate memories into clean JSON arrays. Return ONLY valid JSON, no markdown.' },
						{ role: 'user', content: prompt },
					],
					max_tokens: 4096,
				}, {
					headers: { 'x-session-affinity': 'xaridotis-consolidation' },
				});
				text = result?.response || '';
			} catch (cfErr) {
				console.warn('CF AI consolidation failed, falling back to Gemini:', cfErr.message);
				const { GoogleGenAI } = await import('@google/genai');
				const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });
				const response = await ai.models.generateContent({
					model: 'gemini-3.1-pro-preview',
					contents: [{ role: 'user', parts: [{ text: prompt }] }],
					config: { temperature: 0.2 }
				});
				text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
			}

			const arrayMatch = text.match(/\[[\s\S]*\]/);
			const cleaned = arrayMatch ? arrayMatch[0] : '[]';
			const parsed = JSON.parse(cleaned);

			if (!Array.isArray(parsed) || parsed.length === 0) {
				throw new Error('AI returned empty or invalid consolidation result');
			}

			return parsed;
		});

		// Step 3: Batch write to D1 (atomic: delete old + insert consolidated)
		const writeResult = await step.do('batch-write', async () => {
			const deleteStmt = this.env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId);
			const insertStmts = consolidated.map(m =>
				this.env.DB.prepare(
					'INSERT INTO memories (user_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
				).bind(userId, (m.category || 'general').toLowerCase(), m.fact, m.importance || 1)
			);
			await this.env.DB.batch([deleteStmt, ...insertStmts]);
			return { before: allMemories.length, after: consolidated.length };
		});

		// Step 4: Optimise D1 indexes
		await step.do('optimize-db', async () => {
			await this.env.DB.exec('PRAGMA optimize;');
			return { status: 'optimized' };
		});

		// Step 5: Re-index consolidated memories in Vectorize
		await step.do('reindex-vectors', async () => {
			if (!this.env.VECTORIZE || !this.env.AI) return { status: 'skipped', reason: 'No Vectorize/AI binding' };

			const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
			let indexed = 0;

			for (const m of consolidated) {
				try {
					const truncated = m.fact.slice(0, 512);
					const result = await this.env.AI.run(EMBEDDING_MODEL, { text: [truncated] });
					const vector = result.data[0];
					await this.env.VECTORIZE.upsert([{
						id: `mem_${userId}_${Date.now()}_${indexed}`,
						values: vector,
						metadata: {
							userId: Number(userId),
							category: (m.category || 'general').toLowerCase(),
							fact: m.fact.slice(0, 200),
						},
					}]);
					indexed++;
				} catch { /* continue with remaining */ }
			}

			return { indexed, total: consolidated.length };
		});

		// Step 6: Notify the user
		await step.do('notify-user', async () => {
			const tgPayload = {
				chat_id: chatId,
				text: `<i>Finished deep memory consolidation. ${writeResult.before} memories compressed to ${writeResult.after}. Your memory bank is optimised for the new month.</i>`,
				parse_mode: 'HTML',
			};
			await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(tgPayload),
			});
			return { notified: true };
		});

		return {
			status: 'completed',
			before: writeResult.before,
			after: writeResult.after,
		};
	}
}
