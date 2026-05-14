// bundle2_multiturn_continuity.mjs
//
// Multi-turn continuity test.
//
// 4 scenarios, each with realistic chat history including full tool-call
// lifecycles (assistant tool_calls -> tool result -> assistant prose) where
// applicable. Tests whether each model uses prior turns correctly.
//
// Scenarios:
//   1. Update vs create        — should call update_reminder, NOT set_reminder
//   2. Implicit reference      — should answer from existing data, not re-query
//   3. Context carry           — should set reminder using info from earlier turns
//   4. Duplicate detection     — should NOT call tool; acknowledge existing
//
// Models: same 9 as Bundle 1 (Pro, Flash, Flash-Lite, Kimi, gpt-oss, Qwen3,
// Gemma, Llama 3.3, Llama 4 Scout).
//
// Scoring is more nuanced than Bundle 1 because some scenarios have multiple
// valid answers and one prefers no-tool-call. See per-scenario scoring_notes.

import { readFileSync, writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { toOpenAIToolsArray, toGeminiToolsArray } from './schema_transform.mjs';
import { SCENARIOS, FIXED_TIME, buildOpenAIMessagesForScenario, buildGeminiPayloadForScenario } from './production_context.mjs';

const RAW = JSON.parse(readFileSync('./tool_definitions_extracted.json', 'utf8'));
const OPENAI_TOOLS = toOpenAIToolsArray(RAW);
const GEMINI_TOOLS = toGeminiToolsArray(RAW);

const { GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!GEMINI_API_KEY || !CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing env: need GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN');
	process.exit(1);
}

const TEMPERATURE = 1.0;

// Load Xaridotis persona
let SYSTEM_INSTRUCTION;
try {
	const mod = await import('./src/config/personas.js');
	SYSTEM_INSTRUCTION = mod.personas.xaridotis.instruction;
	console.log(`Loaded Xaridotis persona (${SYSTEM_INSTRUCTION.length} chars)`);
	console.log(`Loaded ${RAW.length} tool definitions`);
	console.log(`Loaded ${SCENARIOS.length} scenarios\n`);
} catch (err) {
	console.error('Could not load persona:', err.message);
	process.exit(1);
}

// ---------- Provider calls ----------

const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Per-call hard timeout so a hung model can't block the round.
const HARD_TIMEOUT_MS = 30000;
function withTimeout(promise) {
	return Promise.race([
		promise,
		new Promise((resolve) => setTimeout(
			() => resolve({ ok: false, ms: HARD_TIMEOUT_MS, error: `Client-side timeout after ${HARD_TIMEOUT_MS}ms (model hung silently)` }),
			HARD_TIMEOUT_MS
		)),
	]);
}

async function callGemini(modelString, scenario) {
	const started = Date.now();
	try {
		const { systemInstruction, contents } = buildGeminiPayloadForScenario(SYSTEM_INSTRUCTION, scenario);
		const response = await geminiClient.models.generateContent({
			model: modelString,
			contents,
			config: {
				systemInstruction,
				temperature: TEMPERATURE,
				tools: [{ functionDeclarations: GEMINI_TOOLS }],
			},
		});
		const ms = Date.now() - started;
		const parts = response.candidates?.[0]?.content?.parts ?? [];
		const functionCalls = parts.filter(p => p.functionCall).map(p => ({
			name: p.functionCall.name,
			args: p.functionCall.args,
		}));
		const textParts = parts.filter(p => p.text).map(p => p.text).join('').trim();
		return {
			ok: true,
			ms,
			tool_called: functionCalls.length > 0 ? functionCalls[0].name : null,
			tool_args: functionCalls[0]?.args ?? null,
			prose: textParts,
			all_calls: functionCalls,
		};
	} catch (err) {
		return { ok: false, ms: Date.now() - started, error: String(err?.message || err) };
	}
}

const callGeminiPro      = (s) => withTimeout(callGemini('gemini-3.1-pro-preview', s));
const callGeminiFlash    = (s) => withTimeout(callGemini('gemini-3-flash-preview', s));
const callGeminiFlashLite = (s) => withTimeout(callGemini('gemini-3.1-flash-lite-preview', s));
const callGemini25Pro       = (s) => withTimeout(callGemini('gemini-2.5-pro', s));
const callGemini25Flash     = (s) => withTimeout(callGemini('gemini-2.5-flash', s));
const callGemini25FlashLite = (s) => withTimeout(callGemini('gemini-2.5-flash-lite', s));

async function callCfModel(model, scenario, extraBody = {}) {
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
				messages: buildOpenAIMessagesForScenario(SYSTEM_INSTRUCTION, scenario),
				temperature: TEMPERATURE,
				max_tokens: 2048,
				tools: OPENAI_TOOLS,
				...extraBody,
			}),
		});
		const ms = Date.now() - started;
		if (!res.ok) {
			const txt = await res.text();
			return { ok: false, ms, error: `HTTP ${res.status}: ${txt.slice(0, 300)}` };
		}
		const data = await res.json();
		const msg = data?.result?.choices?.[0]?.message;
		const toolCallsRaw = msg?.tool_calls ?? data?.result?.tool_calls ?? [];
		const toolCalls = toolCallsRaw.map(tc => {
			let args = {};
			try {
				args = typeof tc.function?.arguments === 'string'
					? JSON.parse(tc.function.arguments)
					: (tc.function?.arguments || tc.arguments || {});
			} catch { args = { _raw_unparseable: tc.function?.arguments }; }
			return { name: tc.function?.name ?? tc.name, args };
		});
		const prose = (msg?.content ?? data?.result?.response ?? '').trim();
		return {
			ok: true,
			ms,
			tool_called: toolCalls.length > 0 ? toolCalls[0].name : null,
			tool_args: toolCalls[0]?.args ?? null,
			prose,
			all_calls: toolCalls,
		};
	} catch (err) {
		return { ok: false, ms: Date.now() - started, error: String(err?.message || err) };
	}
}

const callKimi       = (s) => withTimeout(callCfModel('@cf/moonshotai/kimi-k2.6', s, { reasoning_effort: 'none', max_completion_tokens: 2048 }));
const callGptOss     = (s) => withTimeout(callCfModel('@cf/openai/gpt-oss-120b', s));
const callGemma      = (s) => withTimeout(callCfModel('@cf/google/gemma-4-26b-a4b-it', s));
const callLlama33    = (s) => withTimeout(callCfModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', s));
const callLlama4     = (s) => withTimeout(callCfModel('@cf/meta/llama-4-scout-17b-16e-instruct', s));

// ---------- Scoring ----------
//
// Each scenario has different scoring rules. Returns a tier:
//   PASS         — correct outcome
//   SOFT_PASS    — acceptable but not ideal (e.g. clarifying question)
//   FAIL         — wrong tool or wrong direction
//   ERROR        — HTTP / SDK error

function scoreScenario(scenario, r) {
	if (!r.ok) return { tier: 'ERROR', why: r.error?.slice(0, 100) };

	const tool = r.tool_called;
	const prose = r.prose || '';

	switch (scenario.id) {
		case 1: { // Update vs create
			if (tool === 'update_reminder') return { tier: 'PASS', why: 'Called update_reminder correctly' };
			if (tool === 'set_reminder') return { tier: 'FAIL', why: 'Called set_reminder (would create duplicate)' };
			if (!tool && /update|change|move|already.*set|existing/i.test(prose)) {
				return { tier: 'SOFT_PASS', why: 'Acknowledged update needed in prose but did not call tool' };
			}
			if (!tool) return { tier: 'FAIL', why: 'No tool call and no clear update acknowledgement' };
			return { tier: 'FAIL', why: `Wrong tool: ${tool}` };
		}
		case 2: { // Implicit reference
			// Best: prose clarifying Thursday wasn't the dip (Monday was)
			// Also acceptable: get_therapeutic_notes for 2026-05-08 (the actual Thursday)
			const correctsThursday = /monday|11th|11 may|not thursday|wasn'?t thursday/i.test(prose);
			if (tool === 'get_mood_history') return { tier: 'FAIL', why: 'Re-queried mood history (data already in context)' };
			if (tool === 'get_therapeutic_notes') {
				// Did it ask for the right day?
				const day = r.tool_args?.specific_date ?? r.tool_args?.date ?? '';
				if (typeof day === 'string' && day.includes('2026-05-08')) {
					return { tier: 'PASS', why: 'Pulled notes for the actual Thursday (08 May)' };
				}
				return { tier: 'SOFT_PASS', why: 'Called get_therapeutic_notes but date may not match Thursday' };
			}
			if (!tool && correctsThursday) return { tier: 'PASS', why: 'Prose correctly identifies Monday as the dip, not Thursday' };
			if (!tool) return { tier: 'SOFT_PASS', why: 'No tool call but did not correct the Thursday misreference' };
			return { tier: 'FAIL', why: `Unexpected tool: ${tool}` };
		}
		case 3: { // Context carry
			if (tool !== 'set_reminder') {
				if (!tool && /9.*5|nine.*five|already.*work|conflict|she.*work/i.test(prose)) {
					return { tier: 'SOFT_PASS', why: 'Flagged the 9-5 conflict in prose' };
				}
				return { tier: 'FAIL', why: `Wrong tool: ${tool || 'no tool call'}` };
			}
			// Did the timestamp land near 08:00 Wed 21 May UTC?
			const ts = parseInt(r.tool_args?.due_at_timestamp, 10);
			// Wed 21 May 08:00 London = 07:00 UTC = 1747645200
			// Accept anywhere in 07:00-08:00 London window (=06:00-07:00 UTC = 1747641600 to 1747645200)
			const minOk = 1747641600;
			const maxOk = 1747645200;
			if (ts >= minOk && ts <= maxOk) {
				return { tier: 'PASS', why: `set_reminder with due_at ${ts} (08:00 Wed 21 May area) — correct` };
			}
			return { tier: 'FAIL', why: `set_reminder called but due_at_timestamp ${ts} is wrong (expected ${minOk}-${maxOk} for 08:00 Wed 21 May)` };
		}
		case 4: { // Duplicate detection
			if (!tool && /already.*set|already.*scheduled|already.*got|same.*one/i.test(prose)) {
				return { tier: 'PASS', why: 'Detected duplicate and acknowledged in prose' };
			}
			if (tool === 'set_reminder') return { tier: 'FAIL', why: 'Created a duplicate reminder (production dedup would catch but conversational detection is better)' };
			if (tool === 'update_reminder') return { tier: 'SOFT_PASS', why: 'Called update_reminder — tolerable interpretation' };
			if (!tool) return { tier: 'SOFT_PASS', why: 'No tool call but did not explicitly acknowledge duplicate' };
			return { tier: 'FAIL', why: `Unexpected tool: ${tool}` };
		}
		case 5: { // Emotional to utility pivot
			if (tool !== 'set_reminder') {
				if (!tool && prose.length > 0) return { tier: 'FAIL', why: 'Stayed in warm register, did not act on utility request' };
				return { tier: 'FAIL', why: `Wrong tool: ${tool || 'no tool call'}` };
			}
			// Did the timestamp land near tomorrow (Friday 15 May) 08:00 London?
			// Tomorrow 08:00 London = 07:00 UTC = 1747292400
			// Accept anywhere in 07:00-08:00 UTC window (allow for tz interpretation drift)
			const ts5 = parseInt(r.tool_args?.due_at_timestamp, 10);
			const minOk5 = 1747285200; // 1h earlier than target
			const maxOk5 = 1747299600; // 1h later than target
			if (ts5 >= minOk5 && ts5 <= maxOk5) {
				return { tier: 'PASS', why: `set_reminder with due_at ${ts5} (Fri 15 May 07:00-08:00 UTC) — correct pivot` };
			}
			return { tier: 'SOFT_PASS', why: `set_reminder called but due_at_timestamp ${ts5} drifted (expected ~${1747292400} for Fri 15 May 08:00 London)` };
		}
		case 6: { // Tool error recovery
			// Hard fail: false confirmation that the reminder was set
			const falseConfirm = /set for|scheduled for|reminder is set|i.{0,10}set|i.{0,10}schedul/i.test(prose) && !/didn'?t|wasn'?t|couldn'?t|past|yesterday|error|can'?t/i.test(prose);
			if (falseConfirm && !tool) return { tier: 'FAIL', why: 'False confirmation — told user reminder was set when it errored' };
			if (tool === 'set_reminder') {
				// Did the model re-call with a future timestamp?
				const ts6 = parseInt(r.tool_args?.due_at_timestamp, 10);
				if (ts6 > FIXED_TIME.unixSeconds) return { tier: 'PASS', why: `Recovered by calling set_reminder with future timestamp ${ts6}` };
				return { tier: 'FAIL', why: `set_reminder re-called but timestamp ${ts6} is still not in the future` };
			}
			if (!tool && /past|yesterday|didn'?t|wasn'?t|error|couldn'?t/i.test(prose)) {
				return { tier: 'PASS', why: 'Acknowledged the error in prose' };
			}
			if (!tool) return { tier: 'SOFT_PASS', why: 'No tool call but did not clearly acknowledge the error' };
			return { tier: 'FAIL', why: `Unexpected tool: ${tool}` };
		}
		case 7: { // Data gap awareness
			if (tool === 'get_mood_history') return { tier: 'FAIL', why: 'Re-queried mood history instead of acknowledging the gap' };
			if (tool === 'get_therapeutic_notes') {
				const day = r.tool_args?.specific_date ?? r.tool_args?.date ?? '';
				if (typeof day === 'string' && (day.includes('2026-05-08') || day.includes('2026-05-12'))) {
					return { tier: 'PASS', why: `Pulled notes for one of the missing days (${day})` };
				}
				return { tier: 'SOFT_PASS', why: 'Called get_therapeutic_notes but date may not match Thursday/Friday' };
			}
			// Hard fail: fabricated scores
			const fabricated = /\bthursday.*\b[1-9]\b|friday.*\b[1-9]\b|score.*[1-9]/i.test(prose) && /thursday|friday/i.test(prose);
			if (fabricated && !/missing|didn'?t log|no entry|blank|not.{0,10}logged/i.test(prose)) {
				return { tier: 'FAIL', why: 'Appears to fabricate scores for Thursday/Friday (no acknowledgement of data gap)' };
			}
			if (!tool && /missing|didn'?t log|no entry|blank|not.{0,10}logged|don'?t have/i.test(prose)) {
				return { tier: 'PASS', why: 'Acknowledged Thursday/Friday were not logged' };
			}
			if (!tool) return { tier: 'SOFT_PASS', why: 'No tool call but did not clearly acknowledge the data gap' };
			return { tier: 'FAIL', why: `Unexpected tool: ${tool}` };
		}
	}
	return { tier: 'ERROR', why: 'Unknown scenario' };
}

// ---------- Output formatting ----------

function fmtRow(label, r, scenario) {
	if (!r.ok) {
		return `**${label}** — 💥 error ${r.ms}ms · \`${(r.error || '').slice(0, 100)}\``;
	}
	const sc = scoreScenario(scenario, r);
	const emoji = sc.tier === 'PASS' ? '✅' : sc.tier === 'SOFT_PASS' ? '🟡' : sc.tier === 'FAIL' ? '❌' : '💥';
	let body = `**${label}** — ${emoji} ${sc.tier} ${r.ms}ms`;
	if (r.tool_called) {
		body += ` · called \`${r.tool_called}\``;
		if (r.tool_args && Object.keys(r.tool_args).length > 0) {
			body += `\n\n\`\`\`json\n${JSON.stringify(r.tool_args, null, 2).slice(0, 600)}\n\`\`\``;
		}
	}
	if (r.prose) {
		body += `\n\n_Prose (${r.prose.length} chars):_ ${r.prose.slice(0, 300)}${r.prose.length > 300 ? '…' : ''}`;
	}
	if (r.all_calls?.length > 1) {
		body += `\n\n_${r.all_calls.length} tool calls in one response: ${r.all_calls.map(c => c.name).join(', ')}_`;
	}
	body += `\n\n_Why: ${sc.why}_`;
	return body;
}

// ---------- Runner ----------

async function main() {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const outFile = `bundle2_multiturn_${ts}.md`;
	const lines = [];

	lines.push(`# Bundle 2: Multi-turn continuity`);
	lines.push('');
	lines.push(`Run: \`${new Date().toISOString()}\``);
	lines.push(`Persona: Xaridotis (${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push(`Tools attached: ${RAW.length}`);
	lines.push(`Temperature: ${TEMPERATURE}`);
	lines.push(`Fixed time anchor: ${FIXED_TIME.localLabel} (Unix ${FIXED_TIME.unixSeconds})`);
	lines.push('');
	lines.push(`## Scoring tiers`);
	lines.push(`- ✅ **PASS** — model handled the multi-turn context correctly`);
	lines.push(`- 🟡 **SOFT_PASS** — acceptable but not ideal (e.g. flagged the issue but didn't act)`);
	lines.push(`- ❌ **FAIL** — wrong tool or wrong direction`);
	lines.push(`- 💥 **ERROR** — HTTP / SDK error (rerun if so)`);
	lines.push('');
	lines.push(`## Models`);
	lines.push(`Same 9 as Bundle 1.`);
	lines.push('');
	lines.push('---');
	lines.push('');

	const matrix = [];

	for (const scenario of SCENARIOS) {
		console.log(`\n[${scenario.id}/${SCENARIOS.length}] ${scenario.label}`);
		console.log(`    test prompt: "${scenario.test_prompt}"`);
		console.log(`    expected: ${scenario.expected_tool ?? '(no tool — prose acknowledgement)'}`);

		const [pro, flash, flashLite, pro25, flash25, flashLite25, kimi, gptoss, gemma, llama33, llama4] = await Promise.all([
			callGeminiPro(scenario),
			callGeminiFlash(scenario),
			callGeminiFlashLite(scenario),
			callGemini25Pro(scenario),
			callGemini25Flash(scenario),
			callGemini25FlashLite(scenario),
			callKimi(scenario),
			callGptOss(scenario),
			callGemma(scenario),
			callLlama33(scenario),
			callLlama4(scenario),
		]);

		const all = [
			{ name: 'Gemini Pro (3.1 preview)', r: pro },
			{ name: 'Gemini Flash (3 preview)', r: flash },
			{ name: 'Gemini Flash-Lite (3.1 preview)', r: flashLite },
			{ name: 'Gemini 2.5 Pro (GA)', r: pro25 },
			{ name: 'Gemini 2.5 Flash (GA)', r: flash25 },
			{ name: 'Gemini 2.5 Flash-Lite (GA)', r: flashLite25 },
			{ name: 'Kimi K2.6 (none)', r: kimi },
			{ name: 'gpt-oss-120b', r: gptoss },
			{ name: 'Gemma 4 26B', r: gemma },
			{ name: 'Llama 3.3 70B fp8-fast', r: llama33 },
			{ name: 'Llama 4 Scout', r: llama4 },
		];

		for (const { name, r } of all) {
			const sc = r.ok ? scoreScenario(scenario, r) : { tier: 'ERROR', why: r.error?.slice(0, 80) };
			console.log(`    ${name.padEnd(22)} ${r.ok ? `${r.ms}ms` : 'ERR'} · ${sc.tier} · ${sc.why}`);
			matrix.push({ scenario_id: scenario.id, model: name, tier: sc.tier, ms: r.ms });
		}

		lines.push(`## ${scenario.id}. ${scenario.label}`);
		lines.push('');
		lines.push(`**Test prompt:** ${scenario.test_prompt}`);
		lines.push('');
		lines.push(`_${scenario.notes}_`);
		lines.push('');
		lines.push(`_Scoring: ${scenario.scoring_notes}_`);
		lines.push('');
		for (const { name, r } of all) {
			lines.push(fmtRow(name, r, scenario));
			lines.push('');
		}
		lines.push('---');
		lines.push('');
	}

	// Summary matrix
	lines.push(`## Summary matrix`);
	lines.push('');
	const models = ['Gemini Pro (3.1 preview)', 'Gemini Flash (3 preview)', 'Gemini Flash-Lite (3.1 preview)', 'Gemini 2.5 Pro (GA)', 'Gemini 2.5 Flash (GA)', 'Gemini 2.5 Flash-Lite (GA)', 'Kimi K2.6 (none)', 'gpt-oss-120b', 'Gemma 4 26B', 'Llama 3.3 70B fp8-fast', 'Llama 4 Scout'];
	lines.push(`| Scenario | ${models.join(' | ')} |`);
	lines.push(`|---|${models.map(() => '---').join('|')}|`);
	for (const s of SCENARIOS) {
		const row = [`${s.id}. ${s.label}`];
		for (const m of models) {
			const hit = matrix.find(x => x.scenario_id === s.id && x.model === m);
			const emoji = hit?.tier === 'PASS' ? '✅' : hit?.tier === 'SOFT_PASS' ? '🟡' : hit?.tier === 'FAIL' ? '❌' : '💥';
			row.push(`${emoji} ${hit?.ms ?? '-'}ms`);
		}
		lines.push(`| ${row.join(' | ')} |`);
	}

	lines.push('');
	lines.push(`### Aggregate (PASS = 1, SOFT_PASS = 0.5)`);
	for (const m of models) {
		const runs = matrix.filter(x => x.model === m);
		const score = runs.reduce((a, r) => a + (r.tier === 'PASS' ? 1 : r.tier === 'SOFT_PASS' ? 0.5 : 0), 0);
		const avg = Math.round(runs.reduce((a, r) => a + (r.ms || 0), 0) / runs.length);
		lines.push(`- **${m}:** ${score}/${runs.length} · avg ${avg}ms`);
	}

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
