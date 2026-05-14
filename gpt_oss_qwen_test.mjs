// gpt_oss_qwen_test.mjs
//
// Test gpt-oss-120b and Qwen3-30B-A3B-FP8 with the real Xaridotis persona,
// using the documented API shape for each. Three runs per model.
//
// Looking for:
//   - Clean output (no <think> tags, no reasoning narration in content)
//   - Low latency (sub-5s for fallback use, sub-10s acceptable)
//   - Persona fit (short, in-register replies)
//
// Note on shapes (per Cloudflare docs):
//   - gpt-oss-120b: Responses API — `input` + `instructions`, output in `result.response`
//                   Also test `messages` via /ai/run auto-detection for parity
//   - qwen3-30b-a3b-fp8: Chat Completions — `messages` array, output in
//                        `result.choices[0].message.content`, may emit `reasoning_content`
//
// Both models have reasoning built in with no documented way to disable it.

import { personas } from './src/config/personas.js';

const SYS = personas.xaridotis.instruction;
const USER_TEXT = `okay so i've been thinking about my mum a lot this week and i don't really know why. help me unpack it i guess.`;
const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN');
	process.exit(1);
}

// Same leak phrases we used for Kimi — any of these in the first 400 chars
// of content strongly suggests internal reasoning leaked through.
const LEAK_PHRASES = [
	'help me unpack it',
	"that's an explicit ask",
	'the user is',
	'warm register triggered',
	'i need to',
	'let me think',
	'possible replies',
	'actually,',
	"i'll go with",
	'this is good',
	"i don't have a tool",
	'react_to_message',
];

function detectLeak(content) {
	if (!content) return { tags: false, shape: false };
	const lower = content.toLowerCase().slice(0, 400);
	const tags = content.includes('</think>') || content.includes('<think>');
	const shape = LEAK_PHRASES.some(p => lower.includes(p));
	return { tags, shape };
}

async function callModel(model, body) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${CF_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	const ms = Date.now() - started;
	if (!res.ok) {
		const txt = await res.text();
		return { ok: false, ms, status: res.status, error: txt.slice(0, 300) };
	}
	const data = await res.json();
	// Try multiple known response shapes:
	//   1. result.choices[0].message.content (chat completions)
	//   2. result.response (Responses API / legacy)
	//   3. result.output[0].content[0].text (newer Responses API)
	const content =
		data?.result?.choices?.[0]?.message?.content ??
		data?.result?.response ??
		data?.result?.output?.[0]?.content?.[0]?.text ??
		'';
	const reasoning =
		data?.result?.choices?.[0]?.message?.reasoning_content ??
		data?.result?.reasoning_content ??
		null;
	const leak = detectLeak(content);
	return {
		ok: true,
		ms,
		len: content.length,
		first200: content.slice(0, 200),
		tags: leak.tags,
		shape: leak.shape,
		hasReasoningField: reasoning !== null && reasoning !== '',
		// Surface a hint about which shape the response actually used, so
		// we know which adapter to write for production.
		shapeHint: data?.result?.choices ? 'chat_completions'
		  : data?.result?.response ? 'legacy_response'
		  : data?.result?.output ? 'responses_api'
		  : 'unknown',
	};
}

// ===== gpt-oss-120b =====
// Per Cloudflare docs, native shape is `input` + `instructions` (Responses API).
// /ai/run auto-detects so we can try both styles.

async function callGptOss(style) {
	const body = style === 'responses_api'
		? {
				instructions: SYS,
				input: USER_TEXT,
				max_tokens: 1024,  // default is 256, way too low for warm-register
				// note: temperature default is 0.6 per docs; we'll use 1.0 for parity with prod
				temperature: 1.0,
			}
		: {
				messages: [
					{ role: 'system', content: SYS },
					{ role: 'user', content: USER_TEXT },
				],
				max_tokens: 1024,
				temperature: 1.0,
			};
	return callModel('@cf/openai/gpt-oss-120b', body);
}

// ===== qwen3-30b-a3b-fp8 =====
// Standard chat completions shape, same as Kimi minus the reasoning_effort knob.

async function callQwen() {
	return callModel('@cf/qwen/qwen3-30b-a3b-fp8', {
		messages: [
			{ role: 'system', content: SYS },
			{ role: 'user', content: USER_TEXT },
		],
		temperature: 1.0,
		max_tokens: 1024,
	});
}

console.log(`Testing gpt-oss-120b and qwen3-30b-a3b-fp8 with Xaridotis persona (${SYS.length} chars).`);
console.log(`User prompt: "${USER_TEXT.slice(0, 80)}..."\n`);

const results = [];

// gpt-oss with Responses API shape
console.log('=== gpt-oss-120b (Responses API: input + instructions) ===');
for (let i = 1; i <= 3; i++) {
	const r = await callGptOss('responses_api');
	if (!r.ok) {
		console.log(`  run ${i}: HTTP ${r.status} after ${r.ms}ms · ${r.error}`);
		results.push({ model: 'gpt-oss (resp)', run: i, ...r });
		continue;
	}
	const verdict = r.tags ? 'TAG-LEAK' : r.shape ? 'SHAPE-LEAK' : 'clean';
	console.log(`  run ${i}: ${r.ms}ms · len=${r.len} · ${verdict} · shape=${r.shapeHint}${r.hasReasoningField ? ' · reasoning_content present' : ''}`);
	console.log(`    "${r.first200}"`);
	results.push({ model: 'gpt-oss (resp)', run: i, ...r });
}

// gpt-oss with Chat Completions shape (auto-detect)
console.log('\n=== gpt-oss-120b (Chat Completions: messages array) ===');
for (let i = 1; i <= 3; i++) {
	const r = await callGptOss('messages');
	if (!r.ok) {
		console.log(`  run ${i}: HTTP ${r.status} after ${r.ms}ms · ${r.error}`);
		results.push({ model: 'gpt-oss (chat)', run: i, ...r });
		continue;
	}
	const verdict = r.tags ? 'TAG-LEAK' : r.shape ? 'SHAPE-LEAK' : 'clean';
	console.log(`  run ${i}: ${r.ms}ms · len=${r.len} · ${verdict} · shape=${r.shapeHint}${r.hasReasoningField ? ' · reasoning_content present' : ''}`);
	console.log(`    "${r.first200}"`);
	results.push({ model: 'gpt-oss (chat)', run: i, ...r });
}

// Qwen
console.log('\n=== qwen3-30b-a3b-fp8 (Chat Completions) ===');
for (let i = 1; i <= 3; i++) {
	const r = await callQwen();
	if (!r.ok) {
		console.log(`  run ${i}: HTTP ${r.status} after ${r.ms}ms · ${r.error}`);
		results.push({ model: 'qwen3', run: i, ...r });
		continue;
	}
	const verdict = r.tags ? 'TAG-LEAK' : r.shape ? 'SHAPE-LEAK' : 'clean';
	console.log(`  run ${i}: ${r.ms}ms · len=${r.len} · ${verdict} · shape=${r.shapeHint}${r.hasReasoningField ? ' · reasoning_content present' : ''}`);
	console.log(`    "${r.first200}"`);
	results.push({ model: 'qwen3', run: i, ...r });
}

console.log(`\n\n=== Summary ===`);
const groups = ['gpt-oss (resp)', 'gpt-oss (chat)', 'qwen3'];
for (const g of groups) {
	const runs = results.filter(r => r.model === g && r.ok);
	const clean = runs.filter(r => !r.tags && !r.shape).length;
	const total = results.filter(r => r.model === g).length;
	const avg = runs.length ? Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length) : 0;
	console.log(`${g}: ${clean}/${runs.length} clean (${total - runs.length} errors) · avg ${avg}ms`);
}

console.log(`\nFor reference (from earlier tests):`);
console.log(`  Kimi K2.6 (effort: none): 3/3 clean · avg 3352ms`);
console.log(`  Gemma 4 26B:              ~14000ms avg (eval), variable register fit`);
