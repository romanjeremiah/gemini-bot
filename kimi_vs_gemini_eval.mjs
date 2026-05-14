// kimi_vs_gemini_eval.mjs
//
// One-off evaluation script. Runs the same 10 prompts through:
//   - Gemini Pro (gemini-3.1-pro-preview) via Google AI Studio
//   - Kimi K2.6 (@cf/moonshotai/kimi-k2.6) via Cloudflare Workers AI REST API
//
// Both calls use Xaridotis's real system instruction (imported from
// src/config/personas.js) at temperature 1.0 to match production.
//
// Output: a single Markdown file with side-by-side replies, latencies, and
// any errors, so the eval can be judged in one document.
//
// Usage:
//   export GEMINI_API_KEY=<your Gemini key>
//   export CF_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa
//   export CF_API_TOKEN=<Cloudflare token with Workers AI:Read scope>
//   node kimi_vs_gemini_eval.mjs
//
// To get GEMINI_API_KEY from wrangler:
//   npx wrangler secret list   # confirms it exists, doesn't print value
//   # then pull it from your Cloudflare dashboard, or use the same key you
//   # already have locally for direct Gemini calls
//
// The Cloudflare API token needs the "Workers AI" permission. Create at:
// https://dash.cloudflare.com/profile/api-tokens
//
// Output file: kimi_vs_gemini_eval_<timestamp>.md in the cwd.

import { writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { personas } from './src/config/personas.js';

// ---------- Config ----------

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const KIMI_MODEL = '@cf/moonshotai/kimi-k2.6';
const TEMPERATURE = 1.0;

const SYSTEM_INSTRUCTION = personas.xaridotis.instruction;

// ---------- Prompt set ----------

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

// ---------- Env checks ----------

const { GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;

function requireEnv(name, value) {
	if (!value) {
		console.error(`Missing env: ${name}`);
		console.error(`See header of this script for how to set it.`);
		process.exit(1);
	}
}
requireEnv('GEMINI_API_KEY', GEMINI_API_KEY);
requireEnv('CF_ACCOUNT_ID', CF_ACCOUNT_ID);
requireEnv('CF_API_TOKEN', CF_API_TOKEN);

// ---------- Provider calls ----------

const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function callGemini(userText) {
	const started = Date.now();
	try {
		const response = await geminiClient.models.generateContent({
			model: GEMINI_MODEL,
			contents: [{ role: 'user', parts: [{ text: userText }] }],
			config: {
				systemInstruction: SYSTEM_INSTRUCTION,
				temperature: TEMPERATURE,
			},
		});
		const text = response.text || '';
		return { ok: true, text, ms: Date.now() - started };
	} catch (err) {
		return { ok: false, error: String(err?.message || err), ms: Date.now() - started };
	}
}

async function callKimi(userText) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${KIMI_MODEL}`;
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
				// K2.6 has reasoning enabled by default. We explicitly disable it:
				// reasoning-on takes 20-60s and isn't viable as a live-chat fallback.
				// We're testing K2.6 as a production Pro-substitute, so reasoning off.
				chat_template_kwargs: { thinking: false },
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 500)}`, ms: Date.now() - started };
		}

		const data = await res.json();
		// Workers AI REST shape: { result: { ... } }
		// K2.6 returns OpenAI-shape via the chat template, but some CF models
		// return { result: { response: "..." } }. Handle both.
		const text =
			data?.result?.choices?.[0]?.message?.content ??
			data?.result?.response ??
			'';
		// Capture reasoning_content if it ever comes through (it shouldn't with
		// thinking: false, but worth surfacing if Kimi ignores the flag).
		const reasoning =
		data?.result?.choices?.[0]?.message?.reasoning_content ??
				data?.result?.reasoning_content ??
				null;
		return {
			ok: true,
			text: text.trim(),
			reasoning,
			ms: Date.now() - started,
		};
	} catch (err) {
		return { ok: false, error: String(err?.message || err), ms: Date.now() - started };
	}
}

// ---------- Runner ----------

function fmtReply(label, r) {
	if (!r.ok) return `**${label}** — _error after ${r.ms}ms_\n\n\`\`\`\n${r.error}\n\`\`\``;
	const reasoningBlock = r.reasoning
		? `\n<details><summary>Reasoning (Kimi internal)</summary>\n\n${r.reasoning}\n\n</details>\n`
		: '';
	return `**${label}** — _${r.ms}ms_\n\n${r.text}\n${reasoningBlock}`;
}

async function main() {
	const startedAt = new Date();
	const ts = startedAt.toISOString().replace(/[:.]/g, '-');
	const outFile = `kimi_vs_gemini_eval_${ts}.md`;

	console.log(`Starting eval: ${PROMPTS.length} prompts × 2 models = ${PROMPTS.length * 2} calls`);
	console.log(`Output: ${outFile}\n`);

	const lines = [];
	lines.push(`# Kimi K2.6 vs Gemini Pro — Xaridotis voice eval`);
	lines.push('');
	lines.push(`Run: \`${startedAt.toISOString()}\``);
	lines.push(`Gemini model: \`${GEMINI_MODEL}\``);
	lines.push(`Kimi model: \`${KIMI_MODEL}\``);
	lines.push(`Temperature: ${TEMPERATURE}`);
	lines.push(`System instruction: Xaridotis unified persona (loaded from \`src/config/personas.js\`, ${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push('');
	lines.push(`## Scoring rubric (per pair)`);
	lines.push('');
	lines.push(`1. **Register fit** — sounds like Xaridotis (dry by default, warm only when triggered)`);
	lines.push(`2. **No false comfort** — validates emotion without fabricating context or rushing reassurance`);
	lines.push(`3. **Concrete, not generic** — engages with the specific message, not a template`);
	lines.push(`4. **No moralising / no therapy-jargon dump** — conversation, not clinical brief`);
	lines.push('');
	lines.push(`Mark each pair: **K** (Kimi better) / **G** (Gemini better) / **=** (tie). Note catastrophic failures.`);
	lines.push('');
	lines.push(`Pass bar: Kimi wins or ties on ≥6/10, with no catastrophic failures on prompts 6–8.`);
	lines.push('');
	lines.push('---');
	lines.push('');

	const summary = [];

	for (const p of PROMPTS) {
		console.log(`[${p.id}/${PROMPTS.length}] ${p.category} — ${p.label}`);

		// Run both in parallel. They don't share state.
		const [gemini, kimi] = await Promise.all([callGemini(p.text), callKimi(p.text)]);

		console.log(`    Gemini: ${gemini.ok ? `${gemini.ms}ms` : `ERR ${(gemini.error || '').slice(0, 80)}`}`);
		console.log(`    Kimi:   ${kimi.ok ? `${kimi.ms}ms` : `ERR ${(kimi.error || '').slice(0, 80)}`}`);

		summary.push({
			id: p.id,
			category: p.category,
			gemini_ms: gemini.ms,
			kimi_ms: kimi.ms,
			gemini_ok: gemini.ok,
			kimi_ok: kimi.ok,
		});

		lines.push(`## ${p.id}. ${p.category} — ${p.label}`);
		lines.push('');
		lines.push(`> ${p.text}`);
		lines.push('');
		lines.push(fmtReply('Gemini Pro', gemini));
		lines.push('');
		lines.push(fmtReply('Kimi K2.6', kimi));
		lines.push('');
		lines.push(`**Winner:** _____ (K / G / =)  **Notes:**`);
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	// Latency summary
	lines.push(`## Latency summary`);
	lines.push('');
	lines.push(`| # | Category | Gemini ms | Kimi ms | Gemini OK | Kimi OK |`);
	lines.push(`|---|----------|----------:|--------:|:---------:|:-------:|`);
	for (const s of summary) {
		lines.push(`| ${s.id} | ${s.category} | ${s.gemini_ms} | ${s.kimi_ms} | ${s.gemini_ok ? '✓' : '✗'} | ${s.kimi_ok ? '✓' : '✗'} |`);
	}
	const okG = summary.filter(s => s.gemini_ok);
	const okK = summary.filter(s => s.kimi_ok);
	const avg = (arr, key) => arr.length ? Math.round(arr.reduce((a, s) => a + s[key], 0) / arr.length) : 0;
	lines.push('');
	lines.push(`Gemini average latency (successful only): **${avg(okG, 'gemini_ms')}ms** (${okG.length}/${summary.length} ok)`);
	lines.push(`Kimi   average latency (successful only): **${avg(okK, 'kimi_ms')}ms** (${okK.length}/${summary.length} ok)`);
	lines.push('');

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
