// debug_one_prompt.mjs — diagnose which model hangs on prompt 1.
// Calls Gemini and Kimi sequentially with 25s timeouts on each.

import { GoogleGenAI } from '@google/genai';
import { personas } from './src/config/personas.js';

const SYSTEM_INSTRUCTION = personas.xaridotis.instruction;
const USER_TEXT = `i want to write something tonight but i don't know what about. been a weird day. nothing big just off.`;

const { GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!GEMINI_API_KEY || !CF_ACCOUNT_ID || !CF_API_TOKEN) {
	console.error('Missing env vars');
	process.exit(1);
}

console.log(`System prompt length: ${SYSTEM_INSTRUCTION.length} chars`);
console.log(`User text length: ${USER_TEXT.length} chars`);
console.log('');

// --- Gemini ---
async function testGemini() {
	console.log('--- Gemini Pro ---');
	const started = Date.now();
	const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 25000);

	try {
		const response = await client.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: USER_TEXT }] }],
			config: {
				systemInstruction: SYSTEM_INSTRUCTION,
				temperature: 1.0,
				abortSignal: ctrl.signal,
			},
		});
		clearTimeout(timer);
		console.log(`OK in ${Date.now() - started}ms`);
		console.log(`Reply (first 200 chars): ${(response.text || '').slice(0, 200)}`);
	} catch (err) {
		clearTimeout(timer);
		console.log(`FAIL after ${Date.now() - started}ms: ${err.message || err}`);
	}
	console.log('');
}

// --- Kimi ---
async function testKimi() {
	console.log('--- Kimi K2.6 ---');
	const started = Date.now();
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/moonshotai/kimi-k2.6`;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 25000);

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
					{ role: 'user', content: USER_TEXT },
				],
				temperature: 1.0,
				max_tokens: 4096,
				chat_template_kwargs: { thinking: false },
			}),
			signal: ctrl.signal,
		});
		clearTimeout(timer);

		if (!res.ok) {
			const body = await res.text();
			console.log(`FAIL HTTP ${res.status} after ${Date.now() - started}ms: ${body.slice(0, 400)}`);
			return;
		}

		const data = await res.json();
		const text = data?.result?.choices?.[0]?.message?.content ?? data?.result?.response ?? '';
		const reasoning = data?.result?.choices?.[0]?.message?.reasoning_content ?? null;
		console.log(`OK in ${Date.now() - started}ms`);
		console.log(`Reply (first 200 chars): ${text.slice(0, 200)}`);
		console.log(`Reasoning content present? ${reasoning !== null && reasoning !== ''}`);
		console.log(`Usage: ${JSON.stringify(data?.result?.usage || {})}`);
	} catch (err) {
		clearTimeout(timer);
		console.log(`FAIL after ${Date.now() - started}ms: ${err.message || err}`);
	}
	console.log('');
}

await testGemini();
await testKimi();
console.log('Done.');
