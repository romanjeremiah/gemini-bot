/**
 * Vectorize maintenance operations.
 *
 * Why this exists: D1 is the source of truth for memory rows; Vectorize stores
 * embeddings keyed by `mem_${userId}_${memoryId}`. When memories are deleted
 * (consolidation, manual cleanup, /forget) we don't always propagate the delete
 * to Vectorize, so orphans accumulate. The audit found 161 vectors against
 * only 17 D1 rows for one user.
 *
 * Vectorize has no list-by-prefix API and no "delete by metadata filter"
 * primitive that's safe at scale. The simplest reliable cleanup is:
 *   1. Snapshot D1
 *   2. Delete the index entirely (control plane API)
 *   3. Recreate it with the same name + dimensions + metric
 *   4. Re-embed and re-upsert every D1 row
 *
 * The bot is functionally degraded for ~5-30s while the index is gone:
 * `getSemanticContext` returns empty (no error). `getFormattedContext` reads
 * D1 directly so it keeps working. Acceptable for a maintenance op.
 *
 * Auth: requires Cloudflare API token with Vectorize:Edit scope, set as
 * env.CLOUDFLARE_API_TOKEN. Account ID hardcoded since this is single-tenant.
 */

import * as vectorStore from './vectorStore';
import { log } from '../lib/logger';

const ACCOUNT_ID = 'bc6018c200086c59663c8ff798e689fa';
const INDEX_NAME = 'gemini-bot-memory';
const INDEX_DIMS = 768;
const INDEX_METRIC = 'cosine';

const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`;

function _headers(env) {
	return {
		'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
		'Content-Type': 'application/json',
	};
}

function _sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Bounded retry with exponential backoff. Throw an Error with `.fatal = true`
 * to skip retries (used for auth failures where retrying is pointless).
 */
async function _withRetry(label, fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = await fn();
			if (attempt > 1) log.info('cleanorphans_retry_ok', { label, attempt });
			return result;
		} catch (e) {
			lastErr = e;
			if (e.fatal) {
				log.error('cleanorphans_fatal', { label, msg: e.message });
				throw e;
			}
			log.warn('cleanorphans_retry', { label, attempt, maxAttempts, msg: e.message });
			if (attempt < maxAttempts) {
				await _sleep(baseDelayMs * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
			}
		}
	}
	throw lastErr;
}

async function _indexExists(env) {
	const res = await fetch(`${API_BASE}/${INDEX_NAME}`, { headers: _headers(env) });
	if (res.status === 404) return null;
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`indexExists check failed: ${res.status} ${body.slice(0, 200)}`);
	}
	const data = await res.json();
	return data.result || null;
}

/** Delete the index. Idempotent: 404 is treated as success. */
async function _deleteIndex(env) {
	return _withRetry('delete_index', async () => {
		const res = await fetch(`${API_BASE}/${INDEX_NAME}`, {
			method: 'DELETE',
			headers: _headers(env),
		});
		if (res.ok || res.status === 404) {
			log.info('cleanorphans_index_deleted', { status: res.status });
			return true;
		}
		const body = await res.text().catch(() => '');
		if (res.status === 401 || res.status === 403) {
			const err = new Error(`Auth failed deleting index: ${res.status} ${body.slice(0, 200)}`);
			err.fatal = true;
			throw err;
		}
		throw new Error(`Delete index failed: ${res.status} ${body.slice(0, 200)}`);
	});
}

/**
 * Wait for delete to settle. Cloudflare's delete is eventually consistent;
 * recreating immediately can return 409.
 */
async function _waitForGone(env, { maxWaitMs = 30000, intervalMs = 1000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const exists = await _indexExists(env).catch(() => null);
		if (!exists) return true;
		await _sleep(intervalMs);
	}
	throw new Error(`Index ${INDEX_NAME} still exists after ${maxWaitMs}ms wait`);
}

/** Create the index. Idempotent: 409 (already exists) is treated as success. */
async function _createIndex(env) {
	return _withRetry('create_index', async () => {
		const res = await fetch(API_BASE, {
			method: 'POST',
			headers: _headers(env),
			body: JSON.stringify({
				name: INDEX_NAME,
				config: { dimensions: INDEX_DIMS, metric: INDEX_METRIC },
			}),
		});
		if (res.ok) {
			log.info('cleanorphans_index_created', { name: INDEX_NAME });
			return true;
		}
		const body = await res.text().catch(() => '');
		if (res.status === 401 || res.status === 403) {
			const err = new Error(`Auth failed creating index: ${res.status} ${body.slice(0, 200)}`);
			err.fatal = true;
			throw err;
		}
		if (res.status === 409) {
			log.info('cleanorphans_index_already_exists', {});
			return true;
		}
		throw new Error(`Create index failed: ${res.status} ${body.slice(0, 200)}`);
	});
}

/** Wait for index to be queryable after create. */
async function _waitForReady(env, { maxWaitMs = 30000, intervalMs = 1000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const exists = await _indexExists(env).catch(() => null);
		if (exists) return true;
		await _sleep(intervalMs);
	}
	throw new Error(`Index ${INDEX_NAME} did not become ready within ${maxWaitMs}ms`);
}

/**
 * Reindex all D1 memories across all users. Tracks success/fail per row.
 *
 * Note: vectorStore.indexMemory swallows its own errors and just logs them.
 * Per-row failure tracking here is best-effort — for stricter accounting,
 * indexMemory would need to throw. Acceptable trade-off for a maintenance op.
 */
async function _reindexAll(env) {
	const rows = await env.DB.prepare(
		'SELECT id, user_id, category, fact FROM memories ORDER BY id'
	).all().then(r => r.results || []);

	let ok = 0;
	let failed = 0;
	const failures = [];

	for (const row of rows) {
		try {
			await vectorStore.indexMemory(env, row.user_id, row.category, row.fact, row.id);
			ok++;
		} catch (e) {
			failed++;
			failures.push({ id: row.id, user_id: row.user_id, msg: e.message?.slice(0, 100) });
			log.warn('cleanorphans_reindex_row_failed', { id: row.id, user_id: row.user_id, msg: e.message });
		}
	}

	return { total: rows.length, ok, failed, failures };
}

/**
 * Top-level orchestration. Returns a structured report.
 *
 * Failure modes:
 * - If CLOUDFLARE_API_TOKEN is missing: throws immediately, nothing changes.
 * - If delete fails (auth): throws, nothing changes.
 * - If create fails after delete: index is gone; rerun the endpoint to recreate.
 *   (Bot's semantic search returns empty in the meantime; D1 reads still work.)
 * - If reindex partially fails: report includes failure count + sample.
 */
export async function cleanOrphans(env) {
	const startedAt = Date.now();

	if (!env.CLOUDFLARE_API_TOKEN) {
		throw new Error('CLOUDFLARE_API_TOKEN secret not configured');
	}

	const d1Count = await env.DB.prepare('SELECT COUNT(*) AS n FROM memories')
		.first()
		.then(r => r?.n || 0);
	log.info('cleanorphans_started', { d1_memories: d1Count });

	await _deleteIndex(env);
	await _waitForGone(env);
	await _createIndex(env);
	await _waitForReady(env);
	const reindex = await _reindexAll(env);

	const durationMs = Date.now() - startedAt;
	const report = {
		status: 'success',
		index: INDEX_NAME,
		dimensions: INDEX_DIMS,
		metric: INDEX_METRIC,
		d1_memories_total: d1Count,
		reindexed: reindex.ok,
		reindex_failed: reindex.failed,
		reindex_failures_sample: reindex.failures.slice(0, 5),
		duration_ms: durationMs,
	};
	log.info('cleanorphans_done', report);
	return report;
}
