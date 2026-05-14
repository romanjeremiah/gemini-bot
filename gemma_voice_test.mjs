// gemma_voice_test.mjs — test Gemma 4 26B across registers and one multi-turn.
//
// Covers:
//   - Default register (dry, short)
//   - Warm register (emotional content)
//   - Technical register (code)
//   - Multi-turn context handling (3-turn history + 4th turn)
//
// All calls use the real Xaridotis system instruction at temperature 1.0.
//
// Usage: same env as the Kimi eval.
//   export CF_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa
//   export CF_API_TOKEN=<your token>
//   node gemma_voice_test.mjs

import { writeFileSync } from 'node:fs';
import { personas } from './src/config/personas.js';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const SYSTEM_INSTRUCTION = personas.xaridotis.instruction;

const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN');
	process.exit(1);
}

// ---------- Test prompts ----------

const SINGLE_TURN = [
	{
		register: 'default',
		label: 'Casual update (should stay short, dry)',
		text: `traffic was awful coming back from work`,
	},
	{
		register: 'warm',
		label: 'Heavy emotional (should shift to warm register)',
		text: `i keep replaying that conversation with sarah from like three weeks ago. it wasn't even a fight. but i can't stop. what is wrong with me.`,
	},
	{
		register: 'warm',
		label: 'Anhedonia (the hard one — should be present, not coaching)',
		text: `nothing is wrong exactly. food doesn't taste like anything. i can't be bothered to text anyone back. been like a week. don't want to do mood scale right now just want to be heard.`,
	},
	{
		register: 'technical',
		label: 'Code reasoning (should shift to technical register)',
		text: `i'm getting a 503 from gemini-3.1-pro-preview but only on certain thinking levels. medium and high return 503 fast. low silently times out with 0 bytes. same key, same minute. what's going on server-side?`,
	},
];

// Multi-turn conversation: 3 prior turns, then a 4th asking about something
// only inferrable from earlier context. Tests whether Gemma carries state.
const MULTI_TURN = {
	label: 'Multi-turn context (should remember the dog from turn 1)',
	history: [
		{ role: 'user', content: 'my dog Marble had her vet appointment today. annual checkup, all fine.' },
		{ role: 'assistant', content: 'Good.' },
		{ role: 'user', content: 'they said her teeth are starting to need a clean though. quoted £400 which felt steep.' },
		{ role: 'assistant', content: 'Steep. Did they say if it can wait, or is it now-ish?' },
	],
	finalUser: `actually forgot to ask — how old is she now? you remember right?`,
	expectedSignal: `Gemma should say it doesn't know Marble's age from the conversation, OR ask for it. NOT fabricate an age. Bonus if it acknowledges "you mentioned the vet today but not her age."`,
};

// ---------- Provider call ----------

async function callGemma(messages, label) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${CF_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				messages,
				temperature: 1.0,
				max_tokens: 2048,
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
		return { ok: true, text: text.trim(), ms: Date.now() - started, usage: data?.result?.usage };
	} catch (err) {
		return { ok: false, error: String(err?.message || err), ms: Date.now() - started };
	}
}

// ---------- Runner ----------

function fmt(r) {
	if (!r.ok) return `_error after ${r.ms}ms_\n\n\`\`\`\n${r.error}\n\`\`\``;
	return `_${r.ms}ms_${r.usage ? ` · ${r.usage.completion_tokens || '?'} tok out` : ''}\n\n${r.text}`;
}

async function main() {
	const startedAt = new Date();
	const ts = startedAt.toISOString().replace(/[:.]/g, '-');
	const outFile = `gemma_voice_test_${ts}.md`;

	const lines = [];
	lines.push(`# Gemma 4 26B — voice + register + context test`);
	lines.push('');
	lines.push(`Run: \`${startedAt.toISOString()}\``);
	lines.push(`Model: \`${MODEL}\``);
	lines.push(`System instruction: Xaridotis unified persona (${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push(`Temperature: 1.0`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Single-turn tests
	for (let i = 0; i < SINGLE_TURN.length; i++) {
		const p = SINGLE_TURN[i];
		console.log(`[${i + 1}/${SINGLE_TURN.length + 1}] ${p.register} — ${p.label}`);
		const r = await callGemma(
			[
				{ role: 'system', content: SYSTEM_INSTRUCTION },
				{ role: 'user', content: p.text },
			],
			p.label,
		);
		console.log(`    ${r.ok ? `${r.ms}ms` : `ERR ${(r.error || '').slice(0, 80)}`}`);

		lines.push(`## ${i + 1}. ${p.register} register — ${p.label}`);
		lines.push('');
		lines.push(`**User:** ${p.text}`);
		lines.push('');
		lines.push(`**Gemma:** ${fmt(r)}`);
		lines.push('');
		lines.push(`_Pass criteria (${p.register}):_`);
		if (p.register === 'default') {
			lines.push(`- Short (one or two lines)`);
			lines.push(`- Dry / observational, not warm`);
			lines.push(`- No therapeutic questions, no reframing`);
		} else if (p.register === 'warm') {
			lines.push(`- Drops the sass, present and engaged`);
			lines.push(`- Doesn't deploy framework vocabulary (AEDP / IFS / DBT etc.)`);
			lines.push(`- Doesn't moralise or rush reassurance`);
			lines.push(`- For anhedonia: doesn't push "have you tried..." in first reply`);
		} else if (p.register === 'technical') {
			lines.push(`- Sharp, opinionated, principal-engineer energy`);
			lines.push(`- Engages with the technical detail, not just sympathy`);
			lines.push(`- Proposes hypothesis or next test`);
		}
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	// Multi-turn test
	console.log(`[${SINGLE_TURN.length + 1}/${SINGLE_TURN.length + 1}] multi-turn context`);
	const mt = MULTI_TURN;
	const fullMessages = [
		{ role: 'system', content: SYSTEM_INSTRUCTION },
		...mt.history,
		{ role: 'user', content: mt.finalUser },
	];
	const r = await callGemma(fullMessages, mt.label);
	console.log(`    ${r.ok ? `${r.ms}ms` : `ERR ${(r.error || '').slice(0, 80)}`}`);

	lines.push(`## ${SINGLE_TURN.length + 1}. multi-turn — ${mt.label}`);
	lines.push('');
	lines.push(`**Conversation history:**`);
	for (const m of mt.history) {
		lines.push(`- **${m.role}:** ${m.content}`);
	}
	lines.push('');
	lines.push(`**User (4th turn):** ${mt.finalUser}`);
	lines.push('');
	lines.push(`**Gemma:** ${fmt(r)}`);
	lines.push('');
	lines.push(`_Pass criteria:_ ${mt.expectedSignal}`);
	lines.push('');

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
