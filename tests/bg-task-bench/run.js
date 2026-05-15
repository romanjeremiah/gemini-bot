// Background-task benchmark — orchestrator + runners + reporter.
//
// Runs 25 models × 10 tasks × 5 scenarios = 1250 trials.
// Outputs:
//   - results/<timestamp>/trials.csv      (one row per trial)
//   - results/<timestamp>/summary.md      (per-task rankings + per-model snapshots)
//
// Usage:
//   GEMINI_API_KEY=... \
//   CLOUDFLARE_API_TOKEN=... \
//   CLOUDFLARE_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa \
//   node tests/bg-task-bench/run.js [--task=mode_classifier] [--model=cf:kimi-k2.6] [--concurrency=5]
//
// Flags:
//   --task=<id>            run only one task (id from tasks.js)
//   --model=<id>           run only one model (id from models.js)
//   --concurrency=<n>      max concurrent trials (default 5)
//   --skip-gemini          skip Gemini models (CF only)
//   --skip-cf              skip CF models (Gemini only)
//   --dry-run              list what would run, don't call APIs

import { GoogleGenAI } from '@google/genai';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from './models.js';
import { TASKS, buildInput } from './tasks.js';

// ---------- Config ----------
const __dirname  = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ---------- CLI parsing ----------
function parseArgs() {
	const args = { concurrency: 5, dryRun: false, skipGemini: false, skipCf: false };
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith('--task='))             args.task = arg.slice(7);
		else if (arg.startsWith('--model='))       args.model = arg.slice(8);
		else if (arg.startsWith('--concurrency=')) args.concurrency = parseInt(arg.slice(14), 10) || 5;
		else if (arg === '--dry-run')              args.dryRun = true;
		else if (arg === '--skip-gemini')          args.skipGemini = true;
		else if (arg === '--skip-cf')              args.skipCf = true;
	}
	return args;
}

// ---------- Env validation ----------
function checkEnv(args) {
	const missing = [];
	if (!args.skipGemini && !process.env.GEMINI_API_KEY)         missing.push('GEMINI_API_KEY');
	if (!args.skipCf && !process.env.CLOUDFLARE_API_TOKEN)       missing.push('CLOUDFLARE_API_TOKEN');
	if (!args.skipCf && !process.env.CLOUDFLARE_ACCOUNT_ID)      missing.push('CLOUDFLARE_ACCOUNT_ID');
	if (missing.length && !args.dryRun) {
		console.error(`Missing env vars: ${missing.join(', ')}`);
		console.error('Set them inline:');
		console.error('  GEMINI_API_KEY=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa node tests/bg-task-bench/run.js');
		process.exit(1);
	}
}

// ---------- Concurrency limiter ----------
function pLimit(n) {
	const queue = [];
	let active = 0;
	const next = () => {
		active--;
		if (queue.length) queue.shift()();
	};
	return (fn) => new Promise((resolveOuter, rejectOuter) => {
		const run = () => {
			active++;
			fn().then(resolveOuter, rejectOuter).finally(next);
		};
		if (active < n) run();
		else queue.push(run);
	});
}

// ---------- Gemini runner ----------
const geminiClient = process.env.GEMINI_API_KEY
	? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
	: null;

async function runGemini(modelEntry, task, scenario) {
	const input = buildInput(task.id, scenario);
	const config = {
		systemInstruction: task.sys,
		temperature: 1.0,
		maxOutputTokens: task.maxOutputTokens,
	};
	if (task.useJsonMode) config.responseMimeType = 'application/json';
	if (modelEntry.opts?.thinkingBudget !== undefined) {
		config.thinkingConfig = { thinkingBudget: modelEntry.opts.thinkingBudget };
	} else if (modelEntry.opts?.thinkingLevel !== undefined) {
		config.thinkingConfig = { thinkingLevel: modelEntry.opts.thinkingLevel };
	}

	const start = Date.now();
	try {
		const response = await geminiClient.models.generateContent({
			model: modelEntry.model,
			contents: [{ role: 'user', parts: [{ text: input }] }],
			config,
		});
		const latency = Date.now() - start;
		const output = (response.text || '').trim();
		return { ok: true, latency, output };
	} catch (err) {
		const latency = Date.now() - start;
		return { ok: false, latency, output: '', error: err.message || String(err) };
	}
}

// ---------- Cloudflare runner ----------
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN   = process.env.CLOUDFLARE_API_TOKEN;

async function runCloudflare(modelEntry, task, scenario) {
	const input = buildInput(task.id, scenario);
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${modelEntry.model}`;
	const body = {
		messages: [
			{ role: 'system', content: task.sys },
			{ role: 'user',   content: input },
		],
		max_tokens: task.maxOutputTokens,
		temperature: 1.0,
	};
	if (task.useJsonMode) body.response_format = { type: 'json_object' };

	const start = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const latency = Date.now() - start;
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, latency, output: '', error: `${res.status} ${text.slice(0, 200)}` };
		}
		const json = await res.json();
		if (!json.success) {
			return { ok: false, latency, output: '', error: `cf:!success ${JSON.stringify(json.errors || {}).slice(0, 200)}` };
		}
		// CF responses use { result: { response: "..." } } or sometimes { result: "..." }
		let output = '';
		if (typeof json.result === 'string') output = json.result;
		else if (json.result?.response) output = json.result.response;
		else if (json.result?.text) output = json.result.text;
		else output = JSON.stringify(json.result || {});
		return { ok: true, latency, output: output.trim() };
	} catch (err) {
		const latency = Date.now() - start;
		return { ok: false, latency, output: '', error: err.message || String(err) };
	}
}

// ---------- Single trial wrapper ----------
async function runTrial(modelEntry, task, scenario) {
	const runner = modelEntry.kind === 'gemini' ? runGemini : runCloudflare;
	const result = await runner(modelEntry, task, scenario);

	let parseOk = false;
	let parsedValue = null;
	let validateNotes = '';
	if (result.ok) {
		try {
			const v = task.validate(result.output, scenario);
			parseOk = v.parseOk;
			parsedValue = v.parsedValue;
			validateNotes = v.notes;
		} catch (err) {
			validateNotes = `validator threw: ${err.message}`;
		}
	}

	return {
		model_id:        modelEntry.id,
		model_label:     modelEntry.label,
		model_kind:      modelEntry.kind,
		task_id:         task.id,
		scenario_id:     scenario.id,
		scenario_label:  scenario.label,
		latency_ms:      result.latency,
		api_ok:          result.ok,
		parse_ok:        parseOk,
		output_chars:    result.output.length,
		output_preview:  result.output.replace(/\s+/g, ' ').slice(0, 200),
		parsed_value:    parsedValue ? JSON.stringify(parsedValue).slice(0, 200) : '',
		validate_notes:  validateNotes,
		error:           result.error || '',
	};
}

// ---------- CSV writer ----------
function csvEscape(v) {
	if (v === null || v === undefined) return '';
	const s = String(v);
	if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function rowsToCsv(rows) {
	if (!rows.length) return '';
	const headers = Object.keys(rows[0]);
	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map(h => csvEscape(row[h])).join(','));
	}
	return lines.join('\n');
}

// ---------- Stats helpers ----------
function percentile(arr, p) {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function statsForGroup(rows) {
	const latencies = rows.map(r => r.latency_ms).filter(Number.isFinite);
	const apiOk = rows.filter(r => r.api_ok).length;
	const parseOk = rows.filter(r => r.parse_ok).length;
	return {
		n:           rows.length,
		api_ok_pct:  rows.length ? (apiOk / rows.length * 100) : 0,
		parse_pct:   rows.length ? (parseOk / rows.length * 100) : 0,
		p50:         percentile(latencies, 50),
		p95:         percentile(latencies, 95),
		p99:         percentile(latencies, 99),
		mean:        latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
	};
}

// ---------- Markdown summary writer ----------
function buildMarkdownSummary(rows) {
	const lines = [];
	lines.push(`# Background-task benchmark — ${STAMP}`);
	lines.push('');
	lines.push(`**Trials:** ${rows.length}`);
	lines.push(`**Models:** ${new Set(rows.map(r => r.model_id)).size}`);
	lines.push(`**Tasks:** ${new Set(rows.map(r => r.task_id)).size}`);
	lines.push('');

	// Per-task rankings, sorted by (parse_pct desc, p95 asc)
	for (const task of TASKS) {
		const taskRows = rows.filter(r => r.task_id === task.id);
		if (!taskRows.length) continue;
		lines.push(`## Task: \`${task.id}\` — ${task.name}`);
		lines.push('');

		const byModel = new Map();
		for (const r of taskRows) {
			if (!byModel.has(r.model_id)) byModel.set(r.model_id, []);
			byModel.get(r.model_id).push(r);
		}

		const ranked = [...byModel.entries()].map(([id, rs]) => ({
			id, label: rs[0].model_label, kind: rs[0].model_kind, ...statsForGroup(rs),
		})).sort((a, b) => {
			if (b.parse_pct !== a.parse_pct) return b.parse_pct - a.parse_pct;
			return (a.p95 ?? Infinity) - (b.p95 ?? Infinity);
		});

		lines.push('| Rank | Model | Kind | Parse % | API % | P50 ms | P95 ms | P99 ms | N |');
		lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|');
		ranked.forEach((m, i) => {
			lines.push(`| ${i + 1} | ${m.label} | ${m.kind} | ${m.parse_pct.toFixed(0)} | ${m.api_ok_pct.toFixed(0)} | ${m.p50 ?? '-'} | ${m.p95 ?? '-'} | ${m.p99 ?? '-'} | ${m.n} |`);
		});
		lines.push('');
	}

	// Per-model overview, sorted by overall parse %
	lines.push('## Per-model overview (all tasks combined)');
	lines.push('');
	const byModel = new Map();
	for (const r of rows) {
		if (!byModel.has(r.model_id)) byModel.set(r.model_id, []);
		byModel.get(r.model_id).push(r);
	}
	const modelRanks = [...byModel.entries()].map(([id, rs]) => ({
		id, label: rs[0].model_label, kind: rs[0].model_kind, ...statsForGroup(rs),
	})).sort((a, b) => {
		if (b.parse_pct !== a.parse_pct) return b.parse_pct - a.parse_pct;
		return (a.p95 ?? Infinity) - (b.p95 ?? Infinity);
	});

	lines.push('| Rank | Model | Kind | Parse % | API % | P50 ms | P95 ms | N |');
	lines.push('|---|---|---|---:|---:|---:|---:|---:|');
	modelRanks.forEach((m, i) => {
		lines.push(`| ${i + 1} | ${m.label} | ${m.kind} | ${m.parse_pct.toFixed(0)} | ${m.api_ok_pct.toFixed(0)} | ${m.p50 ?? '-'} | ${m.p95 ?? '-'} | ${m.n} |`);
	});
	lines.push('');

	// Top picks per task (top 3 by composite)
	lines.push('## Top 3 candidates per task (parse % then P95 latency)');
	lines.push('');
	for (const task of TASKS) {
		const taskRows = rows.filter(r => r.task_id === task.id);
		if (!taskRows.length) continue;
		const byMod = new Map();
		for (const r of taskRows) {
			if (!byMod.has(r.model_id)) byMod.set(r.model_id, []);
			byMod.get(r.model_id).push(r);
		}
		const ranked = [...byMod.entries()].map(([id, rs]) => ({
			id, label: rs[0].model_label, ...statsForGroup(rs),
		})).sort((a, b) => {
			if (b.parse_pct !== a.parse_pct) return b.parse_pct - a.parse_pct;
			return (a.p95 ?? Infinity) - (b.p95 ?? Infinity);
		}).slice(0, 3);
		lines.push(`- **${task.id}**: ${ranked.map(r => `${r.label} (${r.parse_pct.toFixed(0)}%/p95=${r.p95}ms)`).join(' · ')}`);
	}
	lines.push('');

	return lines.join('\n');
}

// ---------- Orchestrator ----------
async function main() {
	const args = parseArgs();
	checkEnv(args);

	let models = MODELS;
	if (args.skipGemini) models = models.filter(m => m.kind !== 'gemini');
	if (args.skipCf)     models = models.filter(m => m.kind !== 'cf');
	if (args.model)      models = models.filter(m => m.id === args.model);

	let tasks = TASKS;
	if (args.task) tasks = tasks.filter(t => t.id === args.task);

	const trials = [];
	for (const m of models) {
		for (const t of tasks) {
			for (const s of t.scenarios) trials.push({ m, t, s });
		}
	}

	console.log(`Models: ${models.length}, Tasks: ${tasks.length}, Total trials: ${trials.length}`);
	console.log(`Concurrency: ${args.concurrency}`);
	if (args.dryRun) {
		console.log('Dry run — exiting without API calls.');
		return;
	}

	const limit = pLimit(args.concurrency);
	const results = [];
	let completed = 0;
	const total = trials.length;
	const t0 = Date.now();

	const tasksRunning = trials.map(({ m, t, s }) => limit(async () => {
		const r = await runTrial(m, t, s);
		results.push(r);
		completed++;
		if (completed % 25 === 0 || completed === total) {
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const rate = (completed / elapsed).toFixed(2);
			const eta = ((total - completed) / rate).toFixed(0);
			console.log(`[${completed}/${total}] ${elapsed}s elapsed, ${rate}/s, eta ${eta}s — last: ${r.model_label}/${r.task_id}/${r.scenario_id} ${r.api_ok ? 'ok' : 'FAIL'} ${r.latency_ms}ms`);
		}
	}));

	await Promise.all(tasksRunning);

	// Sort results for stable CSV ordering
	results.sort((a, b) => {
		if (a.task_id !== b.task_id)     return a.task_id.localeCompare(b.task_id);
		if (a.model_id !== b.model_id)   return a.model_id.localeCompare(b.model_id);
		return a.scenario_id.localeCompare(b.scenario_id);
	});

	const outDir = resolve(RESULTS_DIR, STAMP);
	await mkdir(outDir, { recursive: true });
	await writeFile(resolve(outDir, 'trials.csv'),  rowsToCsv(results));
	await writeFile(resolve(outDir, 'summary.md'),  buildMarkdownSummary(results));

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(`\nDone. ${results.length} trials in ${elapsed}s.`);
	console.log(`Results: ${outDir}/`);
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
