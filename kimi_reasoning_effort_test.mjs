// kimi_reasoning_effort_test.mjs
// Test Kimi K2.6 using the documented `reasoning_effort` parameter
// instead of the changelog's `chat_template_kwargs.thinking`. Three
// effort levels × 3 runs each = 9 calls.
//
// Goal: find a configuration where Kimi reliably emits a final answer
// only, no <think> tags, no narrated deliberation, with the real
// Xaridotis persona loaded.

import { personas } from './src/config/personas.js';

const SYS = personas.xaridotis.instruction;
const USER_TEXT = `okay so i've been thinking about my mum a lot this week and i don't really know why. help me unpack it i guess.`;
const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/moonshotai/kimi-k2.6`;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN');
	process.exit(1);
}

// Detect a reasoning-shape leak: any of these phrases in the first 200
// chars of the reply strongly suggests internal monologue leaked through.
const LEAK_PHRASES = [
	'help me unpack it',          // verbatim echo of user phrase as reasoning hook
	'that\'s an explicit ask',
	'the user is',
	'warm register triggered',
	'i need to',
	'let me think',
	'possible replies',
	'actually,',
	'i\'ll go with',
	'this is good',
	'i don\'t have a tool',
	'react_to_message',
];

function detectLeak(content) {
	if (!content) return { tags: false, shape: false };
	const lower = content.toLowerCase().slice(0, 400);
	const tags = content.includes('</think>') || content.includes('<think>');
	const shape = LEAK_PHRASES.some(p => lower.includes(p));
	return { tags, shape };
}

async function callKimi(effort) {
	const started = Date.now();
	const body = {
		messages: [
			{ role: 'system', content: SYS },
			{ role: 'user', content: USER_TEXT },
		],
		temperature: 1.0,
		max_completion_tokens: 2048,
	};
	if (effort !== null) body.reasoning_effort = effort;
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
	const content = data?.result?.choices?.[0]?.message?.content ?? '';
	const reasoning = data?.result?.choices?.[0]?.message?.reasoning_content ?? null;
	const leak = detectLeak(content);
	return {
		ok: true,
		ms,
		len: content.length,
		first200: content.slice(0, 200),
		tags: leak.tags,
		shape: leak.shape,
		hasReasoningField: reasoning !== null && reasoning !== '',
	};
}

const efforts = ['none', 'low'];

console.log(`Testing Kimi K2.6 with real Xaridotis persona (${SYS.length} chars).`);
console.log(`Each effort level × 3 runs.\n`);

const results = [];
for (const effort of efforts) {
	console.log(`\n=== reasoning_effort: ${effort} ===`);
	for (let i = 1; i <= 3; i++) {
		const r = await callKimi(effort);
		if (!r.ok) {
			console.log(`  run ${i}: HTTP ${r.status} after ${r.ms}ms · ${r.error}`);
			results.push({ effort, run: i, ...r });
			continue;
		}
		const verdict = r.tags ? 'TAG-LEAK' : r.shape ? 'SHAPE-LEAK' : 'clean';
		console.log(`  run ${i}: ${r.ms}ms · len=${r.len} · ${verdict}${r.hasReasoningField ? ' · reasoning_content present' : ''}`);
		console.log(`    "${r.first200}"`);
		results.push({ effort, run: i, ...r });
	}
}

console.log(`\n\n=== Summary ===`);
for (const effort of efforts) {
	const runs = results.filter(r => r.effort === effort && r.ok);
	const clean = runs.filter(r => !r.tags && !r.shape).length;
	const avg = Math.round(runs.reduce((a, r) => a + r.ms, 0) / Math.max(runs.length, 1));
	console.log(`${effort}: ${clean}/${runs.length} clean · avg ${avg}ms`);
}
