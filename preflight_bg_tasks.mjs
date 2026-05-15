// preflight_bg_tasks.mjs
//
// Preflight check for bundle_bg_tasks.mjs. For each of the 25 models, sends one
// minimal probe and reports:
//   - Auth working?
//   - Endpoint reachable?
//   - Latency on a trivial 1-token request
//
// Use this before running the full bench to catch:
//   - Missing or wrong-scope API keys
//   - Models that have been deprecated since the catalogue check
//   - Network issues to specific providers
//   - Account-level access (some CF models may not be enabled on every account)
//
// Run:
//   cd ~/Library/CloudStorage/OneDrive-Personal/Documents/GitHub/gemini-bot
//   node preflight_bg_tasks.mjs

import { GoogleGenAI } from '@google/genai';

const CF_ACCOUNT_DEFAULT = 'bc6018c200086c59663c8ff798e689fa';
const { GEMINI_API_KEY, CF_API_TOKEN } = process.env;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || CF_ACCOUNT_DEFAULT;
const PROBE_TIMEOUT_MS = 15000;

// ---------- Env check ----------
const envIssues = [];
if (!GEMINI_API_KEY)                  envIssues.push('GEMINI_API_KEY missing');
else if (GEMINI_API_KEY.length < 20)  envIssues.push(`GEMINI_API_KEY looks too short (${GEMINI_API_KEY.length} chars) — likely placeholder`);
if (!CF_API_TOKEN)                    envIssues.push('CF_API_TOKEN missing');
else if (CF_API_TOKEN.length < 20)    envIssues.push(`CF_API_TOKEN looks too short (${CF_API_TOKEN.length} chars) — likely placeholder`);

console.log('=== Preflight: env ===');
console.log(`GEMINI_API_KEY:    ${GEMINI_API_KEY ? `present (${GEMINI_API_KEY.length} chars, ${GEMINI_API_KEY.slice(0,4)}...${GEMINI_API_KEY.slice(-4)})` : 'MISSING'}`);
console.log(`CF_API_TOKEN:      ${CF_API_TOKEN ? `present (${CF_API_TOKEN.length} chars, ${CF_API_TOKEN.slice(0,4)}...${CF_API_TOKEN.slice(-4)})` : 'MISSING'}`);
console.log(`CF_ACCOUNT_ID:     ${CF_ACCOUNT_ID}${process.env.CF_ACCOUNT_ID ? '' : ' (default)'}`);
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

// ---------- Models (same 25 as bundle_bg_tasks.mjs) ----------
const MODELS = [
	{ id: 'cf:kimi-k2.6',           kind: 'cf',     model: '@cf/moonshotai/kimi-k2.6',                       label: 'kimi-k2.6' },
	{ id: 'cf:glm-4.7-flash',       kind: 'cf',     model: '@cf/zai-org/glm-4.7-flash',                       label: 'glm-4.7-flash' },
	{ id: 'cf:gpt-oss-120b',        kind: 'cf',     model: '@cf/openai/gpt-oss-120b',                          label: 'gpt-oss-120b' },
	{ id: 'cf:gpt-oss-20b',         kind: 'cf',     model: '@cf/openai/gpt-oss-20b',                           label: 'gpt-oss-20b' },
	{ id: 'cf:llama-4-scout-17b',   kind: 'cf',     model: '@cf/meta/llama-4-scout-17b-16e-instruct',          label: 'llama-4-scout-17b' },
	{ id: 'cf:gemma-4-26b',         kind: 'cf',     model: '@cf/google/gemma-4-26b-a4b-it',                    label: 'gemma-4-26b' },
	{ id: 'cf:nemotron-3-120b',     kind: 'cf',     model: '@cf/nvidia/nemotron-3-120b-a12b',                  label: 'nemotron-3-120b' },
	{ id: 'cf:granite-4.0-h-micro', kind: 'cf',     model: '@cf/ibm-granite/granite-4.0-h-micro',              label: 'granite-4.0-h-micro' },
	{ id: 'cf:qwen3-30b-a3b-fp8',   kind: 'cf',     model: '@cf/qwen/qwen3-30b-a3b-fp8',                        label: 'qwen3-30b-a3b-fp8' },
	{ id: 'cf:mistral-small-3.1',   kind: 'cf',     model: '@cf/mistralai/mistral-small-3.1-24b-instruct',     label: 'mistral-small-3.1-24b' },
	{ id: 'cf:qwq-32b',             kind: 'cf',     model: '@cf/qwen/qwq-32b',                                  label: 'qwq-32b' },
	{ id: 'cf:qwen2.5-coder-32b',   kind: 'cf',     model: '@cf/qwen/qwen2.5-coder-32b-instruct',               label: 'qwen2.5-coder-32b' },
	{ id: 'cf:deepseek-r1-32b',     kind: 'cf',     model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',      label: 'deepseek-r1-distill-32b' },
	{ id: 'cf:llama-3.3-70b-fast',  kind: 'cf',     model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',          label: 'llama-3.3-70b-fp8-fast' },
	{ id: 'cf:llama-3.2-3b',        kind: 'cf',     model: '@cf/meta/llama-3.2-3b-instruct',                   label: 'llama-3.2-3b' },
	{ id: 'cf:llama-3.1-8b-fp8',    kind: 'cf',     model: '@cf/meta/llama-3.1-8b-instruct-fp8',                label: 'llama-3.1-8b-fp8' },
	{ id: 'gem:flash-3',     kind: 'gemini', model: 'gemini-3-flash-preview',         label: 'gemini-3-flash' },
	{ id: 'gem:3.1-fl',      kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  label: 'gemini-3.1-fl' },
	{ id: 'gem:3.1-fl-min',  kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'minimal' }, label: 'gemini-3.1-fl-min' },
	{ id: 'gem:3.1-fl-med',  kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'medium' },  label: 'gemini-3.1-fl-med' },
	{ id: 'gem:2.5-fl-dyn',  kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: -1 },       label: 'gemini-2.5-fl-dyn' },
	{ id: 'gem:2.5-fl-b512', kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: 512 },      label: 'gemini-2.5-fl-b512' },
	{ id: 'gem:2.5-pro-dyn', kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: -1 },       label: 'gemini-2.5-pro-dyn' },
	{ id: 'gem:2.5-pro-b128',kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: 128 },      label: 'gemini-2.5-pro-b128' },
	{ id: 'gem:3.1-pro',     kind: 'gemini', model: 'gemini-3.1-pro-preview',         label: 'gemini-3.1-pro' },
];

// ---------- Probe runners ----------
async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms); });
	try { return await Promise.race([promise, timeout]); }
	finally { clearTimeout(timer); }
}

async function probeGemini(m) {
	const config = { temperature: 1.0, maxOutputTokens: 50 };
	if (m.opts?.thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget: m.opts.thinkingBudget };
	else if (m.opts?.thinkingLevel !== undefined) config.thinkingConfig = { thinkingLevel: m.opts.thinkingLevel };
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
	if (/UNAVAILABLE|503/i.test(msg))                    return 'UNAVAILABLE';
	return 'OTHER';
}

async function probeCloudflare(m) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${m.model}`;
	const body = {
		messages: [{ role: 'user', content: 'reply with one word: pong' }],
		max_tokens: 50,
		temperature: 1.0,
	};
	const start = Date.now();
	try {
		const res = await withTimeout(fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}), PROBE_TIMEOUT_MS, m.label);
		const latency = Date.now() - start;
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, latency, error: `${res.status} ${text.slice(0, 200)}`, classify: classifyCfError(res.status, text) };
		}
		const json = await res.json();
		if (!json.success) {
			const errStr = JSON.stringify(json.errors || {}).slice(0, 200);
			return { ok: false, latency, error: `cf:!success ${errStr}`, classify: classifyCfError(200, errStr) };
		}
		let output = '';
		if (typeof json.result === 'string') output = json.result;
		else if (json.result?.response) output = json.result.response;
		else output = JSON.stringify(json.result || {});
		return { ok: true, latency, output: output.trim().slice(0, 40) };
	} catch (err) {
		const msg = err?.message || String(err);
		return { ok: false, latency: Date.now() - start, error: msg.slice(0, 200), classify: msg.includes('timeout') ? 'TIMEOUT' : 'OTHER' };
	}
}

function classifyCfError(status, text) {
	if (status === 401 || status === 403)                      return 'AUTH';
	if (status === 429)                                         return 'RATE-LIMIT';
	if (status === 404 || /not.?found|no such model/i.test(text)) return 'MODEL-NOT-FOUND';
	if (status === 503 || status === 502)                       return 'UNAVAILABLE';
	if (/deprecat/i.test(text))                                 return 'DEPRECATED';
	if (/timeout/i.test(text))                                  return 'TIMEOUT';
	return 'OTHER';
}

// ---------- Run probes (sequential per provider to keep output ordered) ----------
console.log('=== Preflight: model probes ===');
console.log('Sending one minimal "pong" call per model. Timeout 15s each.');
console.log('');

const results = [];

// Group by kind for tidy output
const cfModels = MODELS.filter(m => m.kind === 'cf');
const geminiModels = MODELS.filter(m => m.kind === 'gemini');

console.log(`--- Cloudflare Workers AI (${cfModels.length} models) ---`);
for (const m of cfModels) {
	process.stdout.write(`  ${m.label.padEnd(28)} ... `);
	const r = await probeCloudflare(m);
	results.push({ ...m, ...r });
	if (r.ok) console.log(`OK  ${r.latency}ms  -> "${r.output}"`);
	else      console.log(`FAIL [${r.classify}] ${r.latency}ms  ${r.error}`);
}

console.log('');
console.log(`--- Gemini (${geminiModels.length} variants) ---`);
for (const m of geminiModels) {
	process.stdout.write(`  ${m.label.padEnd(28)} ... `);
	const r = await probeGemini(m);
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
}

console.log('');
if (fail.length === 0) {
	console.log('All 25 models reachable. Safe to run bundle_bg_tasks.mjs.');
	process.exit(0);
} else {
	console.log('Some models failed. Review above — if all failures are MODEL-NOT-FOUND or DEPRECATED');
	console.log('the bench will still run for the OK models. AUTH or RATE-LIMIT means fix before running.');
	process.exit(2);
}
