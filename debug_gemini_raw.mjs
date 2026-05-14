// debug_gemini_raw.mjs — call Gemini Pro with no abort controller so we see
// the actual error from Google's API instead of "operation aborted".

import { GoogleGenAI } from '@google/genai';

const USER_TEXT = 'Say hi in 5 words.';

const { GEMINI_API_KEY } = process.env;
if (!GEMINI_API_KEY) {
	console.error('Missing GEMINI_API_KEY');
	process.exit(1);
}

const models = [
	'gemini-3.1-pro-preview',
	'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview',
];

const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

for (const model of models) {
	console.log(`\n--- ${model} ---`);
	const started = Date.now();
	try {
		const response = await client.models.generateContent({
			model,
			contents: [{ role: 'user', parts: [{ text: USER_TEXT }] }],
			config: { temperature: 1.0 },
		});
		console.log(`OK in ${Date.now() - started}ms: ${(response.text || '').trim()}`);
	} catch (err) {
		console.log(`FAIL after ${Date.now() - started}ms`);
		console.log('  Error name:', err?.name);
		console.log('  Error message:', err?.message);
		console.log('  Error status:', err?.status);
		console.log('  Error code:', err?.code);
		// Dump everything we can see on the error object
		const keys = Object.keys(err || {});
		console.log('  Error keys:', keys);
		if (err?.cause) console.log('  Error cause:', err.cause);
		if (err?.response) console.log('  Error response:', JSON.stringify(err.response).slice(0, 500));
	}
}

console.log('\nDone.');
