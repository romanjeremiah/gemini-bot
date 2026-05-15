// Quick probe: check which CF-hosted partner models (Anthropic + OpenAI) work
// on this account, and what response shape they return.
// Run: node _probe_cf_partner_models.mjs

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || 'bc6018c200086c59663c8ff798e689fa';
const CF_TOKEN = process.env.CF_API_TOKEN;

if (!CF_TOKEN) {
	console.error('CF_API_TOKEN missing');
	process.exit(1);
}

const CANDIDATES = [
	// Anthropic
	'@cf/anthropic/claude-opus-4.7',
	'@cf/anthropic/claude-opus-4.6',
	'@cf/anthropic/claude-sonnet-4.6',
	'@cf/anthropic/claude-sonnet-4.5',
	'@cf/anthropic/claude-sonnet-4',
	'@cf/anthropic/claude-haiku-4.5',
	// OpenAI
	'@cf/openai/gpt-5.5',
	'@cf/openai/gpt-5.5-pro',
	'@cf/openai/gpt-5.4',
	'@cf/openai/gpt-5.4-pro',
	'@cf/openai/gpt-5.4-mini',
	'@cf/openai/gpt-5.4-nano',
	'@cf/openai/gpt-5',
	'@cf/openai/gpt-4.1',
	'@cf/openai/gpt-4.1-mini',
];

console.log(`Probing ${CANDIDATES.length} CF-hosted partner models on account ${CF_ACCOUNT}\n`);

for (const model of CANDIDATES) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;
	const start = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messages: [{ role: 'user', content: 'reply with: pong' }],
				max_tokens: 20,
			}),
		});
		const latency = Date.now() - start;
		const txt = await res.text();
		let shape = 'unknown';
		let output = '';
		if (res.ok) {
			try {
				const j = JSON.parse(txt);
				if (j.success === false) {
					shape = '!success';
					output = JSON.stringify(j.errors || {}).slice(0, 120);
				} else if (j.result?.response) {
					shape = 'cf-standard (result.response)';
					output = j.result.response.slice(0, 40);
				} else if (j.result?.choices?.[0]?.message?.content) {
					shape = 'openai-shape (result.choices)';
					output = j.result.choices[0].message.content.slice(0, 40);
				} else if (j.result?.content?.[0]?.text) {
					shape = 'anthropic-shape (result.content)';
					output = j.result.content[0].text.slice(0, 40);
				} else if (typeof j.result === 'string') {
					shape = 'string-result';
					output = j.result.slice(0, 40);
				} else {
					shape = 'other';
					output = JSON.stringify(j.result || j).slice(0, 100);
				}
				console.log(`  OK   ${latency.toString().padStart(5)}ms  ${model.padEnd(40)} [${shape}] -> "${output}"`);
			} catch (e) {
				console.log(`  ?    ${latency.toString().padStart(5)}ms  ${model.padEnd(40)} [parse-error] ${txt.slice(0, 80)}`);
			}
		} else {
			let reason = `HTTP ${res.status}`;
			try {
				const j = JSON.parse(txt);
				reason = j.errors?.[0]?.message || j.error?.message || txt.slice(0, 100);
			} catch {}
			console.log(`  FAIL ${latency.toString().padStart(5)}ms  ${model.padEnd(40)} [${res.status}] ${reason.slice(0, 100)}`);
		}
	} catch (err) {
		console.log(`  ERR  ${(Date.now() - start).toString().padStart(5)}ms  ${model.padEnd(40)} ${err.message?.slice(0, 100)}`);
	}
}

console.log('\nDone. Use this output to update the bench model registry.');
