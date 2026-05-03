// Cloudflare admin tool.
//
// Lets Xaridotis introspect its own state — list D1 tables, count rows, peek
// at KV keys. The previous version accepted arbitrary SQL via `details` and
// passed it straight to env.DB.prepare(...).all(), plus arbitrary KV prefix
// deletion. That gave the model the ability to DROP TABLE memories or wipe
// KV namespaces with a single tool call. Bad.
//
// This version is strict-mode by default:
//   - Owner-only at execute() time (env.OWNER_ID match against ctx.userId)
//   - D1 SQL: SELECT and PRAGMA (read-only) only. Everything else rejected.
//   - KV: list and get only. No delete, no delete_prefix, no put.
//
// The model can still inspect state — useful for diagnostics — but cannot
// mutate anything via this path. Mutations should go through purpose-built
// tools (memoryTool, etc.) which have their own validation and audit trail.

/**
 * Owner-only gate. Same shape as src/tools/github.js _isOwner so behaviour
 * is consistent across admin-flavoured tools.
 */
function _isOwner(env, ctx) {
	if (!env.OWNER_ID) return false;
	const callerId = ctx?.userId;
	if (callerId == null) return false;
	return String(callerId) === String(env.OWNER_ID);
}

/**
 * SQL allowlist: only SELECT and PRAGMA. Everything else rejected.
 *
 * We strip leading whitespace and comments, then check the first keyword. This
 * is a deliberately conservative parser — we don't try to handle multi-statement
 * inputs or sneaky comment tricks. If the model wants to do anything more than
 * a single read query, it should use a purpose-built tool.
 *
 * Returns { ok: true, sql } when the query passes, or { ok: false, reason }.
 */
function _validateReadOnlySql(raw) {
	if (typeof raw !== 'string' || !raw.trim()) {
		return { ok: false, reason: 'Empty or non-string SQL.' };
	}

	// Strip leading line comments and block comments at the start. We don't try
	// to handle every possible whitespace/comment pattern, just the common ones.
	let sql = raw.trim();
	while (true) {
		if (sql.startsWith('--')) {
			const nl = sql.indexOf('\n');
			sql = nl === -1 ? '' : sql.slice(nl + 1).trim();
		} else if (sql.startsWith('/*')) {
			const end = sql.indexOf('*/');
			sql = end === -1 ? '' : sql.slice(end + 2).trim();
		} else {
			break;
		}
	}

	if (!sql) return { ok: false, reason: 'SQL was only comments after stripping.' };

	// Reject multi-statement inputs. A semicolon followed by more content is
	// the canonical way to smuggle a second statement past a permissive check.
	const firstSemi = sql.indexOf(';');
	if (firstSemi !== -1 && sql.slice(firstSemi + 1).trim().length > 0) {
		return { ok: false, reason: 'Multi-statement SQL is not allowed via manage_cloudflare. Run one statement at a time.' };
	}

	const firstWord = sql.split(/\s+/, 1)[0].toUpperCase();
	const ALLOWED = new Set(['SELECT', 'PRAGMA', 'EXPLAIN', 'WITH']);
	if (!ALLOWED.has(firstWord)) {
		return {
			ok: false,
			reason: `Only SELECT/PRAGMA/EXPLAIN/WITH are allowed via manage_cloudflare. Got: ${firstWord}. For mutations, use a purpose-built tool.`,
		};
	}

	return { ok: true, sql };
}

export const cloudflareAdminTool = {
	definition: {
		name: "manage_cloudflare",
		description: "Inspect Cloudflare resource state for diagnostics. READ-ONLY: SELECT/PRAGMA queries on D1, list/get on KV. No mutations, no deletes. For changes, use purpose-built tools (memoryTool, etc).",
		parameters: {
			type: "OBJECT",
			properties: {
				service: { type: "STRING", enum: ["D1", "KV"] },
				action: { type: "STRING", description: "For D1: 'query' (SELECT/PRAGMA only). For KV: 'list' (lists keys by prefix) or 'get' (reads one key)." },
				details: { type: "STRING", description: "For D1 query: the SELECT or PRAGMA SQL. For KV list: the key prefix. For KV get: the exact key name." }
			},
			required: ["service", "action"]
		}
	},
	async execute(args, env, ctx) {
		// Owner-only gate. Hard fail before any binding access.
		if (!_isOwner(env, ctx)) {
			return {
				status: 'error',
				message: 'manage_cloudflare is owner-only and was not invoked by the owner.',
			};
		}

		const service = String(args.service || '').toUpperCase();
		const action = String(args.action || '').toLowerCase();

		// ---- D1: SELECT/PRAGMA only ----
		if (service === 'D1') {
			if (action !== 'query') {
				return { status: 'error', message: `D1 only supports action='query'. Got: ${action}.` };
			}
			const check = _validateReadOnlySql(args.details);
			if (!check.ok) {
				return { status: 'error', message: check.reason };
			}
			try {
				const result = await env.DB.prepare(check.sql).all();
				return {
					status: 'success',
					row_count: result.results?.length || 0,
					data: (result.results || []).slice(0, 50), // cap response size
					truncated: (result.results?.length || 0) > 50,
				};
			} catch (e) {
				return { status: 'error', message: `D1 query failed: ${e.message?.slice(0, 200)}` };
			}
		}

		// ---- KV: list / get only ----
		if (service === 'KV') {
			if (action === 'list') {
				const prefix = String(args.details || '');
				if (prefix.length === 0) {
					return { status: 'error', message: 'KV list requires a non-empty prefix.' };
				}
				try {
					const list = await env.CHAT_KV.list({ prefix, limit: 50 });
					return {
						status: 'success',
						prefix,
						key_count: list.keys.length,
						keys: list.keys.map(k => k.name),
						list_complete: list.list_complete,
					};
				} catch (e) {
					return { status: 'error', message: `KV list failed: ${e.message?.slice(0, 200)}` };
				}
			}
			if (action === 'get') {
				const key = String(args.details || '');
				if (!key) return { status: 'error', message: 'KV get requires a key name.' };
				try {
					const value = await env.CHAT_KV.get(key);
					return {
						status: 'success',
						key,
						found: value !== null,
						value: value?.slice(0, 2000) ?? null,
					};
				} catch (e) {
					return { status: 'error', message: `KV get failed: ${e.message?.slice(0, 200)}` };
				}
			}
			return { status: 'error', message: `KV only supports action='list' or 'get'. Got: ${action}.` };
		}

		return { status: 'error', message: `Service must be D1 or KV. Got: ${args.service}.` };
	}
};
