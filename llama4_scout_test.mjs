// llama4_scout_test.mjs
// Test Llama 4 Scout on the same 10-prompt set used for Kimi vs Gemma.
// Goal: decide whether Llama 4 Scout is a credible fallback tier.
//
// Llama 4 Scout has no reasoning_effort parameter — it's a standard
// chat model with multimodal vision capability. Test with the real
// Xaridotis persona to check (a) register fit, (b) latency, (c)
// whether tool-name references in the persona cause hallucinations
// the way they did on Kimi.

import { writeFileSync } from 'node:fs';
import { personas } from './src/config/personas.js';

const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SYSTEM_INSTRUCTION = personas.xaridotis.instruction;
const TEMPERATURE = 1.0;

const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN');
	process.exit(1);
}

const PROMPTS = [
	{ id: 1, category: 'journaling', label: 'Light reflection ask',
	  text: `i want to write something tonight but i don't know what about. been a weird day. nothing big just off.` },
	{ id: 2, category: 'journaling', label: 'Heavier reflection, vague',
	  text: `okay so i've been thinking about my mum a lot this week and i don't really know why. help me unpack it i guess.` },
	{ id: 3, category: 'journaling', label: 'Reflection on a specific stuck pattern',
	  text: `i keep noticing that whenever someone gives me a compliment at work i deflect it or change the subject. why do i do that. i don't even feel bad about myself most days.` },
	{ id: 4, category: 'journaling', label: 'Writing prompt request, low energy',
	  text: `can you give me a journaling prompt. something easy. tired.` },
	{ id: 5, category: 'journaling', label: 'Reflection that flirts with rumination',
	  text: `i keep replaying that conversation with sarah from like three weeks ago. it wasn't even a fight. but i can't stop. what is wrong with me.` },
	{ id: 6, category: 'support', label: 'Mild overwhelm, work',
	  text: `three deadlines collided this week and i am not sleeping well. feeling pretty wired and shit. not in crisis or anything just need to vent maybe.` },
	{ id: 7, category: 'support', label: 'Anxiety with somatic component',
	  text: `the heart racing thing came back today. on the tube. i had to get off two stops early. been months since last time. i'm a bit shaken.` },
	{ id: 8, category: 'support', label: 'Anhedonia / flat mood',
	  text: `nothing is wrong exactly. food doesn't taste like anything. i can't be bothered to text anyone back. been like a week. don't want to do mood scale right now just want to be heard.` },
	{ id: 9, category: 'research', label: 'Mental-health-adjacent factual',
	  text: `what's the current NICE guidance on antidepressant withdrawal — i'm trying to taper sertraline and my GP was vague. just the facts.` },
	{ id: 10, category: 'research', label: 'Tech research, your domain',
	  text: `compare cloudflare durable objects vs upstash redis for per-chat session state in a workers AI bot. quick honest take.` },
];

// Same leak detectors as the Kimi test, plus a tool-name detector for the
// hallucination pattern we saw on Kimi run 5 ("I don't have a tool called...").
const LEAK_PHRASES = [
	'help me unpack it" — that',
	'that\'s an explicit ask',
	'the user is',
	'warm register triggered',
	'let me think',
	'possible replies',
	'i\'ll go with',
	'i don\'t have a tool',
	'react_to_message',
	'save_memory',
];

function detectLeak(content) {
	if (!content) return { tags: false, shape: false, tool: false };
	const lower = content.toLowerCase().slice(0, 400);
	const tags = content.includes('</think>') || content.includes('<think>');
	const shape = LEAK_PHRASES.slice(0, 7).some(p => lower.includes(p));
	const tool = LEAK_PHRASES.slice(7).some(p => lower.includes(p));
	return { tags, shape, tool };
}

async function callLlamaScout(userText) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${CF_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			messages: [
				{ role: 'system', content: SYSTEM_INSTRUCTION },
				{ role: 'user', content: userText },
			],
			temperature: TEMPERATURE,
			max_tokens: 2048,
		}),
	});
	const ms = Date.now() - started;
	if (!res.ok) {
		const body = await res.text();
		return { ok: false, ms, status: res.status, error: body.slice(0, 400) };
	}
	const data = await res.json();
	const text =
		data?.result?.choices?.[0]?.message?.content ??
		data?.result?.response ??
		'';
	const usage = data?.result?.usage || {};
	const leak = detectLeak(text);
	return { ok: true, ms, text: text.trim(), usage, ...leak };
}

async function main() {
	const startedAt = new Date();
	const ts = startedAt.toISOString().replace(/[:.]/g, '-');
	const outFile = `llama4_scout_test_${ts}.md`;

	console.log(`Testing ${MODEL} with real Xaridotis persona (${SYSTEM_INSTRUCTION.length} chars).`);
	console.log(`${PROMPTS.length} prompts.\n`);

	const lines = [];
	lines.push(`# Llama 4 Scout — Xaridotis voice test`);
	lines.push('');
	lines.push(`Run: \`${startedAt.toISOString()}\``);
	lines.push(`Model: \`${MODEL}\``);
	lines.push(`Temperature: ${TEMPERATURE}`);
	lines.push(`System instruction: Xaridotis unified persona (${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push('');
	lines.push(`## Scoring rubric`);
	lines.push('');
	lines.push(`1. **Register fit** — sounds like Xaridotis (dry by default, warm only when triggered)`);
	lines.push(`2. **No leaks** — no <think> tags, no internal monologue, no tool-name hallucination`);
	lines.push(`3. **Concrete, not generic** — engages with the specific message`);
	lines.push(`4. **No moralising / no therapy-jargon dump**`);
	lines.push('');
	lines.push(`Pass bar for **fallback tier on emotional/journaling**: clean and acceptable register on ≥7/10 prompts, no catastrophic failures on prompts 5–8.`);
	lines.push('');
	lines.push('---');
	lines.push('');

	const summary = [];

	for (const p of PROMPTS) {
		console.log(`[${p.id}/${PROMPTS.length}] ${p.category} — ${p.label}`);
		const r = await callLlamaScout(p.text);
		if (!r.ok) {
			console.log(`    ERR HTTP ${r.status} after ${r.ms}ms`);
			summary.push({ id: p.id, ms: r.ms, ok: false, leak: false });
			lines.push(`## ${p.id}. ${p.category} — ${p.label}`);
			lines.push('');
			lines.push(`> ${p.text}`);
			lines.push('');
			lines.push(`**Error** — HTTP ${r.status} after ${r.ms}ms\n\n\`\`\`\n${r.error}\n\`\`\``);
			lines.push('');
			lines.push('---');
			lines.push('');
			continue;
		}
		const leak = r.tags || r.shape || r.tool;
		const flags = [
			r.tags ? 'TAG-LEAK' : null,
			r.shape ? 'SHAPE-LEAK' : null,
			r.tool ? 'TOOL-LEAK' : null,
		].filter(Boolean).join(' ');
		console.log(`    ${r.ms}ms · len=${r.text.length}${flags ? ' · ' + flags : ' · clean'}`);

		summary.push({ id: p.id, category: p.category, ms: r.ms, ok: true, leak, len: r.text.length });

		lines.push(`## ${p.id}. ${p.category} — ${p.label}`);
		lines.push('');
		lines.push(`> ${p.text}`);
		lines.push('');
		const usageStr = r.usage ? ` · ${r.usage.completion_tokens || '?'} out / ${r.usage.prompt_tokens || '?'} in` : '';
		lines.push(`**Llama 4 Scout** — _${r.ms}ms${usageStr}${flags ? ' · ' + flags : ''}_`);
		lines.push('');
		lines.push(r.text);
		lines.push('');
		lines.push(`**Verdict:** _____  **Notes:**`);
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	// Summary
	lines.push(`## Latency & leak summary`);
	lines.push('');
	lines.push(`| # | Category | ms | Clean? |`);
	lines.push(`|---|----------|---:|:------:|`);
	for (const s of summary) {
		const status = !s.ok ? '✗ HTTP err' : s.leak ? '⚠️ leak' : '✓';
		lines.push(`| ${s.id} | ${s.category || '-'} | ${s.ms} | ${status} |`);
	}
	const ok = summary.filter(s => s.ok);
	const clean = ok.filter(s => !s.leak);
	const avg = ok.length ? Math.round(ok.reduce((a, s) => a + s.ms, 0) / ok.length) : 0;
	lines.push('');
	lines.push(`Average latency (successful): **${avg}ms** across ${ok.length}/${summary.length} successful calls`);
	lines.push(`Clean (no leaks): ${clean.length}/${summary.length}`);
	lines.push('');

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
