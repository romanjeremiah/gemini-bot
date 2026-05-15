// _probe_unified_api.mjs
// Tests Cloudflare Unified API endpoint per dashboard screenshots.
// The compat endpoint is OpenAI-compatible chat completions for all providers.
//
// Endpoint: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions
// Auth:     Bearer CF_AIG_TOKEN (AI Gateway scoped token, distinct from CF_API_TOKEN)
//
// Run: node _probe_unified_api.mjs
//
// Required: CF_AIG_TOKEN env var (create at https://dash.cloudflare.com/.../ai-gateway -> Settings -> Authentication)

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || 'bc6018c200086c59663c8ff798e689fa';
const CF_GATEWAY = process.env.CF_GATEWAY_ID || 'gemini-bot';
const CF_AIG_TOKEN = process.env.CF_AIG_TOKEN;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

console.log(`Account:  ${CF_ACCOUNT}`);
console.log(`Gateway:  ${CF_GATEWAY}`);
console.log(`CF_AIG_TOKEN: ${CF_AIG_TOKEN ? `present (${CF_AIG_TOKEN.length}c)` : 'MISSING'}`);
console.log(`CF_API_TOKEN: ${CF_API_TOKEN ? `present (${CF_API_TOKEN.length}c)` : 'MISSING'}`);
console.log('');

if (!CF_AIG_TOKEN && !CF_API_TOKEN) {
	console.error('Need at least one of CF_AIG_TOKEN or CF_API_TOKEN.');
	console.error('CF_AIG_TOKEN is the AI Gateway scoped token (create in Gateway -> Settings -> Authentication).');
	console.error('We will try CF_AIG_TOKEN first, then fall back to CF_API_TOKEN.');
	process.exit(1);
}

const TOKEN = CF_AIG_TOKEN || CF_API_TOKEN;
const TOKEN_SOURCE = CF_AIG_TOKEN ? 'CF_AIG_TOKEN' : 'CF_API_TOKEN (fallback)';
console.log(`Using auth: ${TOKEN_SOURCE}`);
console.log('');

const URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/${CF_GATEWAY}/compat/chat/completions`;
console.log(`Endpoint: ${URL}`);
console.log('');

const TEST_MODELS = [
	'anthropic/claude-opus-4.7',
	'anthropic/claude-sonnet-4.6',
	'anthropic/claude-haiku-4.5',
	'openai/gpt-5.5',
	'openai/gpt-5.4',
	'openai/gpt-5.4-mini',
	'openai/gpt-4.1',
	'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
	'workers-ai/@cf/moonshotai/kimi-k2.6',
	'workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct',
];

for (const model of TEST_MODELS) {
	const start = Date.now();
	const body = {
		model,
		messages: [{ role: 'user', content: 'reply with one word: pong' }],
		max_tokens: 20,
	};
	try {
		const res = await fetch(URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		const latency = Date.now() - start;
		const txt = await res.text();
		if (res.ok) {
			try {
				const j = JSON.parse(txt);
				const out = j?.choices?.[0]?.message?.content?.trim() || JSON.stringify(j).slice(0, 80);
				console.log(`  OK   ${latency.toString().padStart(5)}ms  ${model.padEnd(58)} -> "${out.slice(0, 40)}"`);
			} catch (e) {
				console.log(`  ?    ${latency.toString().padStart(5)}ms  ${model.padEnd(58)} parse-error: ${txt.slice(0, 80)}`);
			}
		} else {
			let reason = `HTTP ${res.status}`;
			try {
				const j = JSON.parse(txt);
				reason = j.error?.message || j.errors?.[0]?.message || txt.slice(0, 150);
			} catch { reason = txt.slice(0, 150); }
			console.log(`  FAIL ${latency.toString().padStart(5)}ms  ${model.padEnd(58)} [${res.status}] ${reason.slice(0, 100)}`);
		}
	} catch (err) {
		console.log(`  ERR  ${(Date.now() - start).toString().padStart(5)}ms  ${model.padEnd(58)} ${err.message?.slice(0, 100)}`);
	}
}

console.log('');
console.log('If all 11 pass -> we use this single Unified API path for everything except Gemini.');
console.log('If FAIL [401/403] -> token lacks AI Gateway scope, create a CF_AIG_TOKEN at gateway Settings -> Authentication.');
