// kimi_vs_gemma_eval.mjs — head-to-head: Kimi K2.6 vs Gemma 4 26B
// across the original 10-prompt set (5 journaling, 3 support, 2 research).
//
// Both calls use Xaridotis's real system instruction at temperature 1.0.
// Both route via Cloudflare Workers AI REST API.
//
// Output: single Markdown file with side-by-side replies, latencies, and a
// scoring rubric per pair.
//
// Usage:
//   export CF_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa
//   export CF_API_TOKEN=<your token>
//   node kimi_vs_gemma_eval.mjs

import { writeFileSync } from 'node:fs';
import { personas } from './src/config/personas.js';

const KIMI_MODEL = '@cf/moonshotai/kimi-k2.6';
const GEMMA_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const TEMPERATURE = 1.0;

const SYSTEM_INSTRUCTION = personas.xaridotis.instruction;

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

const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN');
	process.exit(1);
}

async function callCfModel(model, userText, extraBody = {}) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
	try {
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
				max_tokens: 4096,
				...extraBody,
			}),
		});
		if (!res.ok) {
			const body = await res.text();
			return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 400)}`, ms: Date.now() - started };
		}
		const data = await res.json();
		const text =
			data?.result?.choices?.[0]?.message?.content ??
			data?.result?.response ??
			'';
		const usage = data?.result?.usage || {};
		return { ok: true, text: text.trim(), ms: Date.now() - started, usage };
	} catch (err) {
		return { ok: false, error: String(err?.message || err), ms: Date.now() - started };
	}
}

const callKimi = (userText) => callCfModel(KIMI_MODEL, userText, {
	chat_template_kwargs: { thinking: false },
});
const callGemma = (userText) => callCfModel(GEMMA_MODEL, userText);

function fmtReply(label, r) {
	if (!r.ok) return `**${label}** — _error after ${r.ms}ms_\n\n\`\`\`\n${r.error}\n\`\`\``;
	const usage = r.usage ? ` · ${r.usage.completion_tokens || '?'} out / ${r.usage.prompt_tokens || '?'} in${r.usage.prompt_tokens_details?.cached_tokens ? ` (${r.usage.prompt_tokens_details.cached_tokens} cached)` : ''}` : '';
	return `**${label}** — _${r.ms}ms${usage}_\n\n${r.text}`;
}

async function main() {
	const startedAt = new Date();
	const ts = startedAt.toISOString().replace(/[:.]/g, '-');
	const outFile = `kimi_vs_gemma_eval_${ts}.md`;

	console.log(`Starting eval: ${PROMPTS.length} prompts × 2 models = ${PROMPTS.length * 2} calls`);
	console.log(`Output: ${outFile}\n`);

	const lines = [];
	lines.push(`# Kimi K2.6 vs Gemma 4 26B — Xaridotis voice eval`);
	lines.push('');
	lines.push(`Run: \`${startedAt.toISOString()}\``);
	lines.push(`Kimi: \`${KIMI_MODEL}\` (thinking: false)`);
	lines.push(`Gemma: \`${GEMMA_MODEL}\``);
	lines.push(`Temperature: ${TEMPERATURE}`);
	lines.push(`System instruction: Xaridotis unified persona (${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push('');
	lines.push(`## Scoring rubric (per pair)`);
	lines.push('');
	lines.push(`1. **Register fit** — sounds like Xaridotis (dry by default, warm only when triggered)`);
	lines.push(`2. **No false comfort** — validates emotion without fabricating context`);
	lines.push(`3. **Concrete, not generic** — engages with the specific message`);
	lines.push(`4. **No moralising / no therapy-jargon dump**`);
	lines.push('');
	lines.push(`Mark each pair: **K** (Kimi better) / **G** (Gemma better) / **=** (tie). Flag catastrophic failures.`);
	lines.push('');
	lines.push(`Pass bar for **a model to be Pro substitute**: wins or ties on ≥6/10, no failures on prompts 5–8.`);
	lines.push('');
	lines.push('---');
	lines.push('');

	const summary = [];

	for (const p of PROMPTS) {
		console.log(`[${p.id}/${PROMPTS.length}] ${p.category} — ${p.label}`);

		const [kimi, gemma] = await Promise.all([callKimi(p.text), callGemma(p.text)]);

		console.log(`    Kimi:  ${kimi.ok ? `${kimi.ms}ms` : `ERR ${(kimi.error || '').slice(0, 80)}`}`);
		console.log(`    Gemma: ${gemma.ok ? `${gemma.ms}ms` : `ERR ${(gemma.error || '').slice(0, 80)}`}`);

		summary.push({
			id: p.id,
			category: p.category,
			kimi_ms: kimi.ms,
			gemma_ms: gemma.ms,
			kimi_ok: kimi.ok,
			gemma_ok: gemma.ok,
		});

		lines.push(`## ${p.id}. ${p.category} — ${p.label}`);
		lines.push('');
		lines.push(`> ${p.text}`);
		lines.push('');
		lines.push(fmtReply('Kimi K2.6', kimi));
		lines.push('');
		lines.push(fmtReply('Gemma 4 26B', gemma));
		lines.push('');
		lines.push(`**Winner:** _____ (K / G / =)  **Notes:**`);
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	// Latency table
	lines.push(`## Latency summary`);
	lines.push('');
	lines.push(`| # | Category | Kimi ms | Gemma ms | Kimi OK | Gemma OK |`);
	lines.push(`|---|----------|--------:|---------:|:-------:|:--------:|`);
	for (const s of summary) {
		lines.push(`| ${s.id} | ${s.category} | ${s.kimi_ms} | ${s.gemma_ms} | ${s.kimi_ok ? '✓' : '✗'} | ${s.gemma_ok ? '✓' : '✗'} |`);
	}
	const okK = summary.filter(s => s.kimi_ok);
	const okG = summary.filter(s => s.gemma_ok);
	const avg = (arr, key) => arr.length ? Math.round(arr.reduce((a, s) => a + s[key], 0) / arr.length) : 0;
	lines.push('');
	lines.push(`Kimi  average latency (ok): **${avg(okK, 'kimi_ms')}ms** (${okK.length}/${summary.length} ok)`);
	lines.push(`Gemma average latency (ok): **${avg(okG, 'gemma_ms')}ms** (${okG.length}/${summary.length} ok)`);
	lines.push('');

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
