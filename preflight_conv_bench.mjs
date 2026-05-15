// preflight_conv_bench.mjs
//
// Preflight check for bundle_conv_bench.mjs. Probes all 21 models + judge via
// the Cloudflare AI Gateway Unified API (single endpoint, single auth).
//
// Architecture (post-Unified API):
//   - Gemini: direct Google API (caching path)
//   - Everything else: CF Gateway Unified API endpoint /compat/chat/completions
//   - Auth: CF_AIG_TOKEN (AI Gateway scoped token) for Unified; GEMINI_API_KEY for direct
//   - No ANTHROPIC_API_KEY or OPENAI_API_KEY needed (Unified Billing via BYOK in dashboard)
//
// Run:
//   cd ~/Library/CloudStorage/OneDrive-Personal/Documents/GitHub/gemini-bot
//   node preflight_conv_bench.mjs

import { GoogleGenAI } from '@google/genai';

const CF_ACCOUNT_DEFAULT = 'bc6018c200086c59663c8ff798e689fa';
const CF_GATEWAY_DEFAULT = 'gemini-bot';
const { GEMINI_API_KEY, CF_AIG_TOKEN } = process.env;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || CF_ACCOUNT_DEFAULT;
const CF_GATEWAY_ID = process.env.CF_GATEWAY_ID || CF_GATEWAY_DEFAULT;
const PROBE_TIMEOUT_MS = 25000;

const UNIFIED_ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/compat/chat/completions`;

// ---------- Env check ----------
const envIssues = [];
if (!GEMINI_API_KEY)                       envIssues.push('GEMINI_API_KEY missing');
else if (GEMINI_API_KEY.length < 20)       envIssues.push(`GEMINI_API_KEY too short (${GEMINI_API_KEY.length}c)`);
if (!CF_AIG_TOKEN)                         envIssues.push('CF_AIG_TOKEN missing (create at AI Gateway -> Settings -> Authentication)');
else if (CF_AIG_TOKEN.length < 20)         envIssues.push(`CF_AIG_TOKEN too short (${CF_AIG_TOKEN.length}c)`);

console.log('=== Preflight: env ===');
console.log(`GEMINI_API_KEY:    ${GEMINI_API_KEY ? `present (${GEMINI_API_KEY.length}c, ${GEMINI_API_KEY.slice(0,4)}...${GEMINI_API_KEY.slice(-4)})` : 'MISSING'}`);
console.log(`CF_AIG_TOKEN:      ${CF_AIG_TOKEN ? `present (${CF_AIG_TOKEN.length}c, ${CF_AIG_TOKEN.slice(0,4)}...${CF_AIG_TOKEN.slice(-4)})` : 'MISSING'}`);
console.log(`CF_ACCOUNT_ID:     ${CF_ACCOUNT_ID}${process.env.CF_ACCOUNT_ID ? '' : ' (default)'}`);
console.log(`CF_GATEWAY_ID:     ${CF_GATEWAY_ID}${process.env.CF_GATEWAY_ID ? '' : ' (default)'}`);
console.log(`Unified endpoint:  ${UNIFIED_ENDPOINT}`);
if (envIssues.length) {
	console.error('');
	console.error('Env issues:');
	envIssues.forEach(i => console.error(`  - ${i}`));
	console.error('');
	console.error('Fix and re-run. Exiting.');
	process.exit(1);
}
console.log('');

const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---------- Model registry (21 + judge) ----------
// All non-Gemini models use the Unified API string format: `{provider}/{model-id}`.
// For Anthropic, model IDs use dashes (claude-sonnet-4-6, not claude-sonnet-4.6).
// For OpenAI, model IDs use dots (gpt-5.5, gpt-4.1).
// For Workers AI, prefix is `workers-ai/` and model is the full @cf/... binding.
const MODELS = [
	// Gemini direct API (10 variants)
	{ id: 'gem:flash-3',        kind: 'gemini',  model: 'gemini-3-flash-preview',          opts: {},                              label: 'gemini-3-flash' },
	{ id: 'gem:3.1-fl',         kind: 'gemini',  model: 'gemini-3.1-flash-lite-preview',   opts: {},                              label: 'gemini-3.1-fl' },
	{ id: 'gem:3.1-fl-med',     kind: 'gemini',  model: 'gemini-3.1-flash-lite-preview',   opts: { thinkingLevel: 'medium' },     label: 'gemini-3.1-fl-med' },
	{ id: 'gem:3.1-pro',        kind: 'gemini',  model: 'gemini-3.1-pro-preview',          opts: {},                              label: 'gemini-3.1-pro' },
	{ id: 'gem:2.5-flash-b128', kind: 'gemini',  model: 'gemini-2.5-flash',                opts: { thinkingBudget: 128 },         label: 'gemini-2.5-flash-b128' },
	{ id: 'gem:2.5-flash-dyn',  kind: 'gemini',  model: 'gemini-2.5-flash',                opts: { thinkingBudget: -1 },          label: 'gemini-2.5-flash-dyn' },
	{ id: 'gem:2.5-pro-dyn',    kind: 'gemini',  model: 'gemini-2.5-pro',                  opts: { thinkingBudget: -1 },          label: 'gemini-2.5-pro-default' },
	{ id: 'gem:2.5-pro-low',    kind: 'gemini',  model: 'gemini-2.5-pro',                  opts: { thinkingBudget: 128 },         label: 'gemini-2.5-pro-low' },
	{ id: 'gem:2.5-pro-med',    kind: 'gemini',  model: 'gemini-2.5-pro',                  opts: { thinkingBudget: 8192 },        label: 'gemini-2.5-pro-medium' },
	{ id: 'gem:2.5-pro-high',   kind: 'gemini',  model: 'gemini-2.5-pro',                  opts: { thinkingBudget: 24576 },       label: 'gemini-2.5-pro-high' },

	// Anthropic via Unified API (3)
	{ id: 'ant:haiku-4.5',      kind: 'unified', model: 'anthropic/claude-haiku-4-5',      opts: {},                              label: 'claude-haiku-4.5' },
	{ id: 'ant:sonnet-4.6',     kind: 'unified', model: 'anthropic/claude-sonnet-4-6',     opts: {},                              label: 'claude-sonnet-4.6' },
	{ id: 'ant:opus-4.7',       kind: 'unified', model: 'anthropic/claude-opus-4-7',       opts: {},                              label: 'claude-opus-4.7' },

	// OpenAI via Unified API (4)
	{ id: 'oai:gpt-5.5',        kind: 'unified', model: 'openai/gpt-5.5',                  opts: {},                              label: 'gpt-5.5' },
	{ id: 'oai:gpt-5.4',        kind: 'unified', model: 'openai/gpt-5.4',                  opts: {},                              label: 'gpt-5.4' },
	{ id: 'oai:gpt-5.4-mini',   kind: 'unified', model: 'openai/gpt-5.4-mini',             opts: {},                              label: 'gpt-5.4-mini' },
	{ id: 'oai:gpt-4.1',        kind: 'unified', model: 'openai/gpt-4.1',                  opts: {},                              label: 'gpt-4.1' },

	// Workers AI via Unified API (4)
	{ id: 'cf:llama-3.3-70b',   kind: 'unified', model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',  opts: {},          label: 'llama-3.3-70b-fast' },
	{ id: 'cf:llama-4-scout',   kind: 'unified', model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',   opts: {},          label: 'llama-4-scout-17b' },
	{ id: 'cf:kimi-k2.6',       kind: 'unified', model: 'workers-ai/@cf/moonshotai/kimi-k2.6',                   opts: {},          label: 'kimi-k2.6' },
	{ id: 'cf:mistral-3.1',     kind: 'unified', model: 'workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct', opts: {},        label: 'mistral-small-3.1-24b' },
];

// Judge: Claude Opus 4.7 via Unified API. Same as ant:opus-4.7 entry above.
const JUDGE_MODEL = { id: 'judge:opus-4.7', kind: 'unified', model: 'anthropic/claude-opus-4-7', label: 'judge:claude-opus-4.7' };

// ---------- Probe runners ----------
async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms); });
	try { return await Promise.race([promise, timeout]); }
	finally { clearTimeout(timer); }
}

async function probeGemini(m) {
	const config = { temperature: 1.0, maxOutputTokens: 50 };
	if (m.opts?.thinkingBudget !== undefined)      config.thinkingConfig = { thinkingBudget: m.opts.thinkingBudget };
	else if (m.opts?.thinkingLevel !== undefined)  config.thinkingConfig = { thinkingLevel: m.opts.thinkingLevel };
	const start = Date.now();
	try {
		const res = await withTimeout(geminiClient.models.generateContent({
			model: m.model,
			contents: [{ role: 'user', parts: [{ text: 'reply with one word: pong' }] }],
			config,
		}), PROBE_TIMEOUT_MS, m.label);
		const text = (res.text || '').trim();
		return { ok: true, latency: Date.now() - start, output: text.slice(0, 40) };
	} catch (err) {
		const msg = err?.message || String(err);
		return { ok: false, latency: Date.now() - start, error: msg.slice(0, 200), classify: classifyGeminiError(msg) };
	}
}

function classifyGeminiError(msg) {
	if (/API_KEY_INVALID|API key not valid/i.test(msg)) return 'AUTH';
	if (/PERMISSION_DENIED/i.test(msg))                  return 'AUTH-perm';
	if (/RESOURCE_EXHAUSTED|rate.?limit|429/i.test(msg)) return 'RATE-LIMIT';
	if (/NOT_FOUND|404|not found/i.test(msg))            return 'MODEL-NOT-FOUND';
	if (/timeout/i.test(msg))                            return 'TIMEOUT';
	if (/UNAVAILABLE|503|overload/i.test(msg))           return 'UNAVAILABLE';
	return 'OTHER';
}

async function probeUnified(m) {
	// OpenAI GPT-5+ family uses 'max_completion_tokens'; everything else uses 'max_tokens'.
	const useCompletionTokens = /^openai\/gpt-(5|6|o\d)/.test(m.model);
	const body = {
		model: m.model,
		messages: [{ role: 'user', content: 'reply with one word: pong' }],
		temperature: 1.0,
		...(useCompletionTokens
			? { max_completion_tokens: 50 }
			: { max_tokens: 50 }),
	};
	const start = Date.now();
	try {
		const res = await withTimeout(fetch(UNIFIED_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${CF_AIG_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		}), PROBE_TIMEOUT_MS, m.label);
		const latency = Date.now() - start;
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, latency, error: `${res.status} ${text.slice(0, 250)}`, classify: classifyHttpError(res.status, text) };
		}
		const json = await res.json();
		const output = json?.choices?.[0]?.message?.content?.trim() || JSON.stringify(json).slice(0, 80);
		return { ok: true, latency, output: output.slice(0, 40) };
	} catch (err) {
		const msg = err?.message || String(err);
		return { ok: false, latency: Date.now() - start, error: msg.slice(0, 200), classify: msg.includes('timeout') ? 'TIMEOUT' : 'OTHER' };
	}
}

function classifyHttpError(status, text) {
	if (status === 401 || status === 403) {
		if (/Invalid Anthropic|didn't provide an API key/i.test(text)) return 'BYOK-MISSING';
		return 'AUTH';
	}
	if (status === 429)                                                       return 'RATE-LIMIT';
	if (status === 404 || /not.?found|no such model/i.test(text))             return 'MODEL-NOT-FOUND';
	if (status === 400 && /model/i.test(text))                                return 'MODEL-NOT-FOUND';
	if (status === 503 || status === 502 || /overload/i.test(text))           return 'UNAVAILABLE';
	if (/deprecat/i.test(text))                                               return 'DEPRECATED';
	if (/timeout/i.test(text))                                                return 'TIMEOUT';
	return 'OTHER';
}

// ---------- Run probes ----------
console.log('=== Preflight: model probes ===');
console.log('Sending one minimal "pong" call per model. Timeout 25s each.');
console.log('');

const results = [];

const geminiList  = MODELS.filter(m => m.kind === 'gemini');
const unifiedList = MODELS.filter(m => m.kind === 'unified');

console.log(`--- Gemini (${geminiList.length}) direct API ---`);
for (const m of geminiList) {
	process.stdout.write(`  ${m.label.padEnd(28)} ... `);
	const r = await probeGemini(m);
	results.push({ ...m, ...r });
	if (r.ok) console.log(`OK  ${r.latency}ms  -> "${r.output}"`);
	else      console.log(`FAIL [${r.classify}] ${r.latency}ms  ${r.error}`);
}

console.log('');
console.log(`--- Via CF Gateway Unified API (${unifiedList.length}) ---`);
for (const m of unifiedList) {
	process.stdout.write(`  ${m.label.padEnd(28)} ... `);
	const r = await probeUnified(m);
	results.push({ ...m, ...r });
	if (r.ok) console.log(`OK  ${r.latency}ms  -> "${r.output}"`);
	else      console.log(`FAIL [${r.classify}] ${r.latency}ms  ${r.error}`);
}

// ---------- Summary ----------
console.log('');
console.log('=== Summary ===');
const ok = results.filter(r => r.ok);
const fail = results.filter(r => !r.ok);
console.log(`OK:    ${ok.length}/${results.length}`);
console.log(`FAIL:  ${fail.length}/${results.length}`);

if (ok.length) {
	const lats = ok.map(r => r.latency).sort((a, b) => a - b);
	const median = lats[Math.floor(lats.length / 2)];
	const p95 = lats[Math.floor(lats.length * 0.95)] ?? lats[lats.length - 1];
	const max = lats[lats.length - 1];
	console.log(`Latency (probe, OK only): median ${median}ms · P95 ${p95}ms · max ${max}ms`);
}

if (fail.length) {
	console.log('');
	console.log('Failures grouped by class:');
	const byClass = new Map();
	for (const r of fail) {
		if (!byClass.has(r.classify)) byClass.set(r.classify, []);
		byClass.get(r.classify).push(r.label);
	}
	for (const [cls, labels] of byClass) {
		console.log(`  [${cls}] ${labels.length} model(s): ${labels.join(', ')}`);
	}

	if (byClass.has('BYOK-MISSING')) {
		console.log('');
		console.log('FIX [BYOK-MISSING]: configure provider keys in CF Gateway dashboard:');
		console.log('  dash.cloudflare.com -> AI -> AI Gateway -> gemini-bot -> Settings -> Provider Keys (or BYOK)');
		console.log('  Add your Anthropic and OpenAI API keys there. CF Gateway then proxies transparently.');
	}
	if (byClass.has('UNAVAILABLE')) {
		console.log('');
		console.log('NOTE [UNAVAILABLE]: 2.5 Pro variants under high demand. Transient — usually clears within minutes.');
	}
	if (byClass.has('TIMEOUT')) {
		console.log('');
		console.log('NOTE [TIMEOUT]: Some Gemini models over-think the trivial probe. With proper bench fixtures they should respond within 60s hard timeout.');
	}
}

console.log('');
if (fail.length === 0) {
	console.log('All 21 models reachable. Safe to run bundle_conv_bench.mjs.');
	process.exit(0);
} else {
	const fatal = fail.some(f => f.classify === 'AUTH' || f.classify === 'AUTH-perm' || f.classify === 'BYOK-MISSING');
	if (fatal) {
		console.log('FATAL: AUTH or BYOK failures. Fix before running bench.');
		process.exit(2);
	}
	console.log('Non-fatal: TIMEOUT / UNAVAILABLE failures may be transient.');
	console.log('Bench will still run for the OK models. Re-run preflight to check transient failures.');
	process.exit(2);
}
