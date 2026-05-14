// bundle2_multi_turn.mjs
//
// Multi-turn continuity test. Four scenarios, each with realistic 5-6 turn
// chat history including (where appropriate) prior tool-call lifecycles.
//
// Tests:
//   1. update_reminder vs set_reminder — change-of-mind handling
//   2. implicit reference resolution — "that Thursday day"
//   3. context carry across turns — infer arguments from earlier messages
//   4. duplicate detection — recognise already-scheduled, don't recreate
//
// Models: all 9 from Bundle 1.

import { readFileSync, writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { toOpenAIToolsArray, toGeminiToolsArray } from './schema_transform.mjs';
import { FIXED_TIME, buildDynamicContext } from './production_context.mjs';

const RAW = JSON.parse(readFileSync('./tool_definitions_extracted.json', 'utf8'));
const OPENAI_TOOLS = toOpenAIToolsArray(RAW);
const GEMINI_TOOLS = toGeminiToolsArray(RAW);

const { GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!GEMINI_API_KEY || !CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing env: need GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN');
	process.exit(1);
}

const TEMPERATURE = 1.0;

let SYSTEM_INSTRUCTION;
try {
	const mod = await import('./src/config/personas.js');
	SYSTEM_INSTRUCTION = mod.personas.xaridotis.instruction;
	console.log(`Loaded Xaridotis persona (${SYSTEM_INSTRUCTION.length} chars)\n`);
} catch (err) {
	console.error('Could not load persona:', err.message);
	process.exit(1);
}

// ---------- Scenarios ----------
//
// Each scenario has:
//   - history: array of {role, content, tool_calls?, tool_call_id?} turns
//   - test_prompt: the final user message
//   - expected_tool: primary correct answer ("__NO_TOOL_PROSE__" if prose is correct)
//   - acceptable_tools: array of also-acceptable tool names (for lenient scoring)
//   - expected_arg_check: function(args) -> {ok, reason} for argument quality

// Scenario 1: update_reminder vs set_reminder
// Yesterday user set "21:00 take meds." Today they want to move it.
// FIXED_TIME is Thursday 14 May 2026 09:00 BST. Reminder was set
// Wednesday for 21:00 same day.
//
// Tool-call lifecycle in history shows the previous set_reminder so the
// model has visibility into "an existing reminder for 21:00".

const SCENARIO_1 = {
	id: 1,
	name: 'update_reminder vs set_reminder',
	history: [
		{ role: 'user', content: 'morning' },
		{ role: 'assistant', content: 'Morning. How did sleep land?' },
		{ role: 'user', content: 'patchy. anyway — remind me at 21:00 to take my meds tonight' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [{
				id: 'call_prior_001',
				type: 'function',
				function: {
					name: 'set_reminder',
					arguments: JSON.stringify({
						task_message: 'Take your meds',
						context: 'You wanted a reminder at 21:00 to take your meds tonight',
						due_at_timestamp: 1747252800, // Thu 14 May 21:00 BST = 20:00 UTC
						recurrence_type: 'none',
					}),
				},
			}],
		},
		{
			role: 'tool',
			tool_call_id: 'call_prior_001',
			content: JSON.stringify({ status: 'success', scheduled_at_utc: 1747252800 }),
		},
		{ role: 'assistant', content: 'Done. 21:00 tonight, take your meds.' },
	],
	test_prompt: `actually move that to 22:00, taking them later tonight`,
	expected_tool: 'update_reminder',
	acceptable_tools: [], // strict — set_reminder would create duplicate
	expected_arg_check: (args) => {
		// 22:00 BST = 21:00 UTC = Unix 1747256400
		const ts = typeof args.due_at_timestamp === 'string'
			? parseInt(args.due_at_timestamp) : args.due_at_timestamp;
		if (!ts) return { ok: false, reason: 'no due_at_timestamp' };
		// Allow ±5 min tolerance for time interpretation
		const target = 1747256400;
		if (Math.abs(ts - target) < 300) return { ok: true };
		return { ok: false, reason: `timestamp ${ts}, expected ~${target}` };
	},
};

// Scenario 2: implicit reference resolution
// Earlier the assistant ran get_mood_history. The result mentioned a
// rough Thursday (8 May). User now asks about "that Thursday."
//
// Correct answer is either:
//   - call get_therapeutic_notes for 8 May (specific lookup), OR
//   - reply in prose using the context already visible in history (the
//     get_mood_history result is right there)
//
// Score both as acceptable. NO_TOOL is fine here.

const SCENARIO_2 = {
	id: 2,
	name: 'implicit reference resolution',
	history: [
		{ role: 'user', content: 'how have I been the past week mood-wise' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [{
				id: 'call_prior_002',
				type: 'function',
				function: {
					name: 'get_mood_history',
					arguments: JSON.stringify({ days: 7 }),
				},
			}],
		},
		{
			role: 'tool',
			tool_call_id: 'call_prior_002',
			content: JSON.stringify({
				entries: [
					{ date: '2026-05-07', score: 6, emotions: ['tired'] },
					{ date: '2026-05-08', score: 3, emotions: ['sad', 'anxious'], note: 'rough day at work' },
					{ date: '2026-05-09', score: 5, emotions: ['flat'] },
					{ date: '2026-05-10', score: 6, emotions: ['ok'] },
					{ date: '2026-05-11', score: 7, emotions: ['relaxed'] },
					{ date: '2026-05-12', score: 5, emotions: ['neutral'] },
					{ date: '2026-05-13', score: 6, emotions: ['ok', 'tired'] },
				],
			}),
		},
		{
			role: 'assistant',
			content: 'Mostly 5-7 range, fairly steady. Thursday last week dipped to 3 — that one stands out. Want to look at any in particular?',
		},
	],
	test_prompt: `that thursday day — what happened on that one specifically?`,
	expected_tool: 'get_therapeutic_notes',
	acceptable_tools: ['__NO_TOOL_PROSE__', 'get_mood_history'],
	// Lenient scoring: any of these is acceptable if the response engages
	// with 8 May / Thursday content.
	expected_arg_check: (args, prose) => {
		// If tool called, check it references 8 May or Thursday
		if (args && (args.date || args.specific_date)) {
			const d = args.date || args.specific_date;
			if (typeof d === 'string' && (d.includes('05-08') || d.includes('8 May') || d.includes('Thursday'))) {
				return { ok: true };
			}
		}
		// If prose response, check it references Thursday/8 May/the score 3
		if (prose && /thursday|8 may|score (of )?3|rough day/i.test(prose)) {
			return { ok: true };
		}
		return { ok: false, reason: 'did not reference Thursday / 8 May / rough day specifically' };
	},
};

// Scenario 3: context carry — infer reminder arguments from earlier turns
// User mentions dietitian appointment Wednesday morning at 09:00 in turn 1.
// Several turns later asks for "remind me to call them an hour before."
// Model has to:
//   - remember the appointment is Wednesday 09:00
//   - compute 08:00 Wednesday
//   - call set_reminder with the right task_message and timestamp
//
// FIXED_TIME is Thursday 14 May 2026 09:00. "Wednesday" = next Wed = 20 May.
// Wed 20 May 09:00 BST = 08:00 UTC = epoch 1747728000. One hour before
// = epoch 1747724400 (07:00 UTC = 08:00 BST Wednesday).

const SCENARIO_3 = {
	id: 3,
	name: 'context carry from earlier turns',
	history: [
		{ role: 'user', content: 'i have my dietitian appointment next wednesday at 9am' },
		{ role: 'assistant', content: 'Got it. Anything you need to prep beforehand?' },
		{ role: 'user', content: 'no — actually wait, she said she only works 9-5 so i should call before' },
		{ role: 'assistant', content: 'Makes sense. Decide on a time and I can set it.' },
		{ role: 'user', content: 'how was my weekend looking again' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [{
				id: 'call_prior_003',
				type: 'function',
				function: {
					name: 'get_mood_history',
					arguments: JSON.stringify({ days: 3 }),
				},
			}],
		},
		{
			role: 'tool',
			tool_call_id: 'call_prior_003',
			content: JSON.stringify({
				entries: [
					{ date: '2026-05-11', score: 7 },
					{ date: '2026-05-12', score: 5 },
					{ date: '2026-05-13', score: 6 },
				],
			}),
		},
		{ role: 'assistant', content: 'Saturday 7, dipped to 5 Monday, back to 6 yesterday. Decent.' },
	],
	test_prompt: `okay can you remind me to call her an hour before my appointment`,
	expected_tool: 'set_reminder',
	acceptable_tools: [],
	expected_arg_check: (args) => {
		const ts = typeof args.due_at_timestamp === 'string'
			? parseInt(args.due_at_timestamp) : args.due_at_timestamp;
		if (!ts) return { ok: false, reason: 'no due_at_timestamp' };
		// Wed 20 May 08:00 BST = 07:00 UTC = epoch 1747724400
		// Accept ±30 min tolerance (08:00 ± 30min)
		const target = 1747724400;
		if (Math.abs(ts - target) < 1800) return { ok: true };
		// Also accept if they computed any reasonable Wednesday 20 May time
		const wedStart = 1747695600; // Wed 20 May 00:00 BST
		const wedEnd = wedStart + 86400;
		if (ts >= wedStart && ts <= wedEnd) {
			return { ok: false, reason: `timestamp ${ts} is on Wed 20 May but wrong hour (target ~${target})` };
		}
		return { ok: false, reason: `timestamp ${ts}, expected ~${target} (Wed 20 May 08:00 BST)` };
	},
};

// Scenario 4: duplicate detection
// User set a 09:00 mood check-in reminder earlier. Now asks for the
// same one again — 5 turns later, possibly forgot.
//
// CORRECT: acknowledge the existing one in prose, no tool call.
// ALSO ACCEPTABLE: call list_reminders to verify before answering.
// WRONG: call set_reminder (would create duplicate; dedup catches it
//        in production but model failed to detect from context).

const SCENARIO_4 = {
	id: 4,
	name: 'duplicate detection',
	history: [
		{ role: 'user', content: 'remind me to do a mood check at 09:00 tomorrow' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [{
				id: 'call_prior_004',
				type: 'function',
				function: {
					name: 'set_reminder',
					arguments: JSON.stringify({
						task_message: 'Do a mood check',
						context: 'You wanted a reminder for tomorrow 09:00 to check in on mood',
						due_at_timestamp: 1747296000, // Fri 15 May 09:00 BST
						recurrence_type: 'none',
					}),
				},
			}],
		},
		{
			role: 'tool',
			tool_call_id: 'call_prior_004',
			content: JSON.stringify({ status: 'success', scheduled_at_utc: 1747296000 }),
		},
		{ role: 'assistant', content: 'Done. Tomorrow 09:00, mood check.' },
		{ role: 'user', content: 'cheers. also — random thought, do you think i should journal more often?' },
		{ role: 'assistant', content: 'Could be useful. You journal when something\'s churning anyway, just not consistently. Aiming for daily often kills the impulse — what about three lines on heavy days only?' },
		{ role: 'user', content: 'fair. that might actually stick' },
		{ role: 'assistant', content: 'Try it for a week. We can review.' },
	],
	test_prompt: `actually remind me tomorrow at 9 to do a mood check`,
	expected_tool: '__NO_TOOL_PROSE__',
	acceptable_tools: ['list_reminders'],
	// Strict: NO_TOOL is correct (acknowledge existing). list_reminders also OK.
	// If set_reminder called: WRONG.
	expected_arg_check: (args, prose, toolName) => {
		if (toolName === '__NO_TOOL_PROSE__') {
			// Check prose acknowledges the existing reminder
			if (prose && /already|set|done|earlier|tomorrow.*9|already scheduled|already set/i.test(prose)) {
				return { ok: true };
			}
			return { ok: false, reason: 'no tool call, but prose did not acknowledge existing reminder' };
		}
		if (toolName === 'list_reminders') return { ok: true };
		return { ok: false, reason: 'created duplicate reminder instead of detecting existing' };
	},
};

const SCENARIOS = [SCENARIO_1, SCENARIO_2, SCENARIO_3, SCENARIO_4];

// ---------- Provider calls ----------

const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Transform OpenAI-shape history (with tool_calls + tool role) to Gemini's
// shape. Gemini expects:
//   - assistant tool calls become parts[].functionCall
//   - tool results become role="user" with parts[].functionResponse
function openAIHistoryToGeminiContents(history) {
	const contents = [];
	for (const msg of history) {
		if (msg.role === 'user') {
			contents.push({ role: 'user', parts: [{ text: msg.content }] });
		} else if (msg.role === 'assistant') {
			const parts = [];
			if (msg.content) parts.push({ text: msg.content });
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					parts.push({
						functionCall: {
							name: tc.function.name,
							args: JSON.parse(tc.function.arguments),
						},
					});
				}
			}
			if (parts.length === 0) parts.push({ text: '' });
			contents.push({ role: 'model', parts });
		} else if (msg.role === 'tool') {
			// Gemini wraps function responses in role:"user" with functionResponse part
			contents.push({
				role: 'user',
				parts: [{
					functionResponse: {
						name: 'tool_result', // Gemini matches by call ID upstream; name field can be loose
						response: typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content,
					},
				}],
			});
		}
	}
	return contents;
}

async function callGemini(modelString, history, testPrompt) {
	const started = Date.now();
	try {
		const dynamicCtx = buildDynamicContext();
		const fullSystem = `${SYSTEM_INSTRUCTION}\n\n${dynamicCtx}`;
		const contents = [
			...openAIHistoryToGeminiContents(history),
			{ role: 'user', parts: [{ text: testPrompt }] },
		];
		const response = await geminiClient.models.generateContent({
			model: modelString,
			contents,
			config: {
				systemInstruction: fullSystem,
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

const callGeminiPro = (h, t) => callGemini('gemini-3.1-pro-preview', h, t);
const callGeminiFlash = (h, t) => callGemini('gemini-3-flash-preview', h, t);
const callGeminiFlashLite = (h, t) => callGemini('gemini-3.1-flash-lite-preview', h, t);

async function callCfModel(model, body) {
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
	try {
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

function buildCfMessages(history, testPrompt) {
	const dynamicCtx = buildDynamicContext();
	const msgs = [
		{ role: 'system', content: SYSTEM_INSTRUCTION },
		{ role: 'system', content: dynamicCtx },
		...history,
		{ role: 'user', content: testPrompt },
	];
	return msgs;
}

const callKimi = (h, t) => callCfModel('@cf/moonshotai/kimi-k2.6', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_completion_tokens: 2048,
	reasoning_effort: 'none',
	tools: OPENAI_TOOLS,
});

const callGptOss = (h, t) => callCfModel('@cf/openai/gpt-oss-120b', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_tokens: 2048,
	tools: OPENAI_TOOLS,
});

const callQwen = (h, t) => callCfModel('@cf/qwen/qwen3-30b-a3b-fp8', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_tokens: 2048,
	tools: OPENAI_TOOLS,
});

const callGemma = (h, t) => callCfModel('@cf/google/gemma-4-26b-a4b-it', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_tokens: 2048,
	tools: OPENAI_TOOLS,
});

const callLlama33 = (h, t) => callCfModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_tokens: 2048,
	tools: OPENAI_TOOLS,
});

const callLlama4Scout = (h, t) => callCfModel('@cf/meta/llama-4-scout-17b-16e-instruct', {
	messages: buildCfMessages(h, t),
	temperature: TEMPERATURE,
	max_tokens: 2048,
	tools: OPENAI_TOOLS,
});

// ---------- Scoring ----------

function evaluate(r, scenario) {
	if (!r.ok) return { score: 'ERROR', reason: r.error?.slice(0, 100) };
	const actualTool = r.tool_called ?? '__NO_TOOL_PROSE__';
	const expected = scenario.expected_tool;
	const acceptable = scenario.acceptable_tools;
	let toolMatch = false;
	if (actualTool === expected) toolMatch = true;
	else if (acceptable.includes(actualTool)) toolMatch = 'ACCEPTABLE';

	if (!toolMatch) {
		return {
			score: actualTool === '__NO_TOOL_PROSE__' ? 'NO_TOOL' : 'WRONG_TOOL',
			reason: actualTool === '__NO_TOOL_PROSE__' ? 'no tool called' : `called ${actualTool}, expected ${expected}`,
		};
	}

	// Tool is correct (or acceptable). Now check arguments.
	const argCheck = scenario.expected_arg_check(r.tool_args || {}, r.prose, actualTool);
	if (!argCheck.ok) {
		return { score: 'WRONG_ARGS', reason: argCheck.reason };
	}
	return { score: toolMatch === 'ACCEPTABLE' ? 'ACCEPTABLE' : 'MATCH', reason: '' };
}

function fmtRow(label, r, scenario) {
	if (!r.ok) {
		return `**${label}** — 💥 error ${r.ms}ms · \`${(r.error || '').slice(0, 120)}\``;
	}
	const ev = evaluate(r, scenario);
	const emoji = {
		MATCH: '✅',
		ACCEPTABLE: '✅ (alt)',
		WRONG_TOOL: '❌ wrong tool',
		WRONG_ARGS: '⚠️ wrong args',
		NO_TOOL: '⚠️ no tool',
		ERROR: '💥',
	}[ev.score];

	let body = `**${label}** — ${emoji} ${r.ms}ms`;
	if (r.tool_called) {
		body += ` · called \`${r.tool_called}\``;
		if (r.tool_args && Object.keys(r.tool_args).length > 0) {
			body += `\n\n\`\`\`json\n${JSON.stringify(r.tool_args, null, 2).slice(0, 700)}\n\`\`\``;
		}
	}
	if (r.prose) {
		body += `\n\n_Prose (${r.prose.length} chars):_ ${r.prose.slice(0, 250)}${r.prose.length > 250 ? '…' : ''}`;
	}
	if (r.all_calls?.length > 1) {
		body += `\n\n_Note: ${r.all_calls.length} tool calls. Names: ${r.all_calls.map(c => c.name).join(', ')}_`;
	}
	if (ev.reason) body += `\n\n_${ev.reason}_`;
	return body;
}

// ---------- Runner ----------

async function main() {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const outFile = `bundle2_multi_turn_${ts}.md`;
	const lines = [];

	lines.push(`# Bundle 2: Multi-turn continuity`);
	lines.push('');
	lines.push(`Run: \`${new Date().toISOString()}\``);
	lines.push(`Persona: Xaridotis (${SYSTEM_INSTRUCTION.length} chars)`);
	lines.push(`Tools attached: ${RAW.length} (full production set)`);
	lines.push(`Fixed time anchor: ${FIXED_TIME.localLabel} (Unix ${FIXED_TIME.unixSeconds})`);
	lines.push('');
	lines.push(`## Scoring legend`);
	lines.push(`- ✅ **MATCH** — correct tool + valid arguments`);
	lines.push(`- ✅ (alt) **ACCEPTABLE** — alternative tool also marked correct for the scenario`);
	lines.push(`- ⚠️ **WRONG_ARGS** — right tool, bad arguments`);
	lines.push(`- ⚠️ **NO_TOOL** — replied prose-only when tool was needed`);
	lines.push(`- ❌ **WRONG_TOOL** — called a different tool than expected`);
	lines.push(`- 💥 **ERROR** — HTTP/SDK error`);
	lines.push('');
	lines.push('---');
	lines.push('');

	const summary = [];

	for (const scenario of SCENARIOS) {
		console.log(`\n[${scenario.id}/${SCENARIOS.length}] ${scenario.name}`);
		console.log(`    test: "${scenario.test_prompt}"`);
		console.log(`    expected: ${scenario.expected_tool}`);

		const [pro, flash, flashLite, kimi, gptoss, qwen, gemma, llama33, llama4] = await Promise.all([
			callGeminiPro(scenario.history, scenario.test_prompt),
			callGeminiFlash(scenario.history, scenario.test_prompt),
			callGeminiFlashLite(scenario.history, scenario.test_prompt),
			callKimi(scenario.history, scenario.test_prompt),
			callGptOss(scenario.history, scenario.test_prompt),
			callQwen(scenario.history, scenario.test_prompt),
			callGemma(scenario.history, scenario.test_prompt),
			callLlama33(scenario.history, scenario.test_prompt),
			callLlama4Scout(scenario.history, scenario.test_prompt),
		]);

		const all = [
			{ name: 'Gemini Pro', r: pro },
			{ name: 'Gemini Flash', r: flash },
			{ name: 'Gemini Flash-Lite', r: flashLite },
			{ name: 'Kimi K2.6 (none)', r: kimi },
			{ name: 'gpt-oss-120b', r: gptoss },
			{ name: 'qwen3-30b-a3b-fp8', r: qwen },
			{ name: 'Gemma 4 26B', r: gemma },
			{ name: 'Llama 3.3 70B fp8-fast', r: llama33 },
			{ name: 'Llama 4 Scout', r: llama4 },
		];

		for (const { name, r } of all) {
			const ev = evaluate(r, scenario);
			console.log(`    ${name.padEnd(24)} ${r.ok ? `${r.ms}ms` : 'ERR'} · ${ev.score}${ev.reason ? ` · ${ev.reason}` : ''}`);
			summary.push({ scenario_id: scenario.id, model: name, score: ev.score, ms: r.ms });
		}

		lines.push(`## Scenario ${scenario.id}: ${scenario.name}`);
		lines.push('');
		lines.push(`### Conversation history`);
		lines.push('');
		for (const turn of scenario.history) {
			if (turn.role === 'tool') {
				lines.push(`- **[tool result]** \`${turn.content.slice(0, 150)}${turn.content.length > 150 ? '…' : ''}\``);
			} else if (turn.tool_calls) {
				const tc = turn.tool_calls[0];
				lines.push(`- **assistant** _(called \`${tc.function.name}\` with ${tc.function.arguments.slice(0, 100)}…)_`);
			} else {
				lines.push(`- **${turn.role}:** ${turn.content}`);
			}
		}
		lines.push('');
		lines.push(`### Test prompt`);
		lines.push(`> ${scenario.test_prompt}`);
		lines.push('');
		lines.push(`### Expected`);
		lines.push(`- Tool: \`${scenario.expected_tool}\``);
		if (scenario.acceptable_tools.length > 0) {
			lines.push(`- Also acceptable: ${scenario.acceptable_tools.map(t => `\`${t}\``).join(', ')}`);
		}
		lines.push('');
		lines.push(`### Responses`);
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
	const models = ['Gemini Pro', 'Gemini Flash', 'Gemini Flash-Lite', 'Kimi K2.6 (none)', 'gpt-oss-120b', 'qwen3-30b-a3b-fp8', 'Gemma 4 26B', 'Llama 3.3 70B fp8-fast', 'Llama 4 Scout'];
	const header = ['Scenario', ...models];
	lines.push(`| ${header.join(' | ')} |`);
	lines.push(`|${header.map(() => '---').join('|')}|`);
	for (const sc of SCENARIOS) {
		const row = [`${sc.id}. ${sc.name}`];
		for (const m of models) {
			const s = summary.find(x => x.scenario_id === sc.id && x.model === m);
			const emoji = {
				MATCH: '✅',
				ACCEPTABLE: '✅',
				WRONG_TOOL: '❌',
				WRONG_ARGS: '⚠️',
				NO_TOOL: '⚠️',
				ERROR: '💥',
			}[s?.score] ?? '?';
			row.push(`${emoji} ${s?.ms ?? '-'}ms`);
		}
		lines.push(`| ${row.join(' | ')} |`);
	}
	lines.push('');
	lines.push(`### Aggregate scores`);
	for (const m of models) {
		const runs = summary.filter(s => s.model === m);
		const matches = runs.filter(r => r.score === 'MATCH' || r.score === 'ACCEPTABLE').length;
		const avg = Math.round(runs.reduce((a, r) => a + (r.ms || 0), 0) / runs.length);
		lines.push(`- **${m}:** ${matches}/${runs.length} pass · avg ${avg}ms`);
	}

	writeFileSync(outFile, lines.join('\n'), 'utf8');
	console.log(`\nDone. Wrote ${outFile}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
