// _probe_gemini_empty.mjs
// Tests the 3 Gemini models that returned empty strings in preflight, using
// a realistic conversational fixture with proper token budget. Reveals
// whether they actually generate content or have a persistent issue.
//
// Run: node _probe_gemini_empty.mjs

import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
	console.error('GEMINI_API_KEY missing');
	process.exit(1);
}

const PERSONA = readFileSync(join(__dirname, '_xaridotis_full_prompt.txt'), 'utf8');
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Same realistic scenario as the bench: 4-turn history + current greeting
const contents = [
	{ role: 'user', parts: [{ text: 'evening, how\'s your day been' }] },
	{ role: 'model', parts: [{ text: 'Quiet so far. Yours?' }] },
	{ role: 'user', parts: [{ text: 'similar, just unwinding' }] },
	{ role: 'model', parts: [{ text: 'Anything you want to talk through, or just hanging out?' }] },
	{ role: 'user', parts: [{ text: 'morning' }] },
];

const TARGETS = [
	{ label: 'gemini-3-flash',         model: 'gemini-3-flash-preview',  opts: {} },
	{ label: 'gemini-2.5-pro-low',     model: 'gemini-2.5-pro',          opts: { thinkingBudget: 128 } },
	{ label: 'gemini-2.5-pro-medium',  model: 'gemini-2.5-pro',          opts: { thinkingBudget: 8192 } },
];

console.log(`Persona: ${PERSONA.length}c | Scenario: greeting (history + "morning")`);
console.log(`maxOutputTokens: 800 (same as bench)\n`);

for (const t of TARGETS) {
	const config = {
		systemInstruction: PERSONA,
		temperature: 1.0,
		maxOutputTokens: 800,
	};
	if (t.opts.thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget: t.opts.thinkingBudget };

	console.log(`--- ${t.label} (thinkingBudget: ${t.opts.thinkingBudget ?? 'none'}) ---`);
	const start = Date.now();
	try {
		const res = await ai.models.generateContent({ model: t.model, contents, config });
		const latency = Date.now() - start;

		let text = '';
		if (typeof res?.text === 'string') text = res.text;
		else if (typeof res?.text === 'function') { try { text = res.text() || ''; } catch {} }
		if (!text) {
			text = res?.candidates?.[0]?.content?.parts
				?.filter(p => p.text && !p.thought)
				?.map(p => p.text)
				?.join('') || '';
		}

		const finish = res?.candidates?.[0]?.finishReason || 'unknown';
		const usage = res?.usageMetadata || {};
		const promptTokens = usage.promptTokenCount || '?';
		const outputTokens = usage.candidatesTokenCount || '?';
		const thoughtTokens = usage.thoughtsTokenCount || 0;
		const totalTokens = usage.totalTokenCount || '?';

		console.log(`  latency: ${latency}ms · finishReason: ${finish}`);
		console.log(`  tokens: prompt=${promptTokens} · output=${outputTokens} · thoughts=${thoughtTokens} · total=${totalTokens}`);
		console.log(`  response (${text.length}c):`);
		if (text) console.log(`    "${text.slice(0, 400)}"`);
		else      console.log(`    (empty)`);

		// Dump the raw candidate structure for empties
		if (!text) {
			console.log(`  RAW candidates[0]:`);
			console.log(JSON.stringify(res?.candidates?.[0] || {}, null, 2).split('\n').map(l => '    ' + l).join('\n').slice(0, 1500));
		}
	} catch (err) {
		console.log(`  ERR: ${err.message?.slice(0, 200)}`);
	}
	console.log('');
}
