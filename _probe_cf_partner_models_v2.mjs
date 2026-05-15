// _probe_cf_partner_models_v2.mjs
//
// Tests multiple URL patterns for accessing CF-proxied partner models from
// REST (outside a Worker). Docs show binding syntax with gateway routing —
// we need to find the REST equivalent.
//
// Run: node _probe_cf_partner_models_v2.mjs

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || 'bc6018c200086c59663c8ff798e689fa';
const CF_TOKEN = process.env.CF_API_TOKEN;
const CF_GATEWAY = process.env.CF_GATEWAY_ID || 'gemini-bot';

if (!CF_TOKEN) {
	console.error('CF_API_TOKEN missing');
	process.exit(1);
}

// Test against one Anthropic and one OpenAI model
const TEST_MODELS = [
	'anthropic/claude-opus-4.7',
	'openai/gpt-5.5',
];

// URL patterns to try
function urlPatterns(model) {
	return [
		// Pattern A: direct /ai/run/ without @cf prefix
		{ label: 'A: ai/run direct',
		  url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}` },
		// Pattern B: /ai/run/ with explicit gateway query param
		{ label: 'B: ai/run + gateway=default',
		  url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}?gateway=default` },
		// Pattern C: AI Gateway URL with workers-ai provider, default gateway
		{ label: 'C: gateway/default/workers-ai',
		  url: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/default/workers-ai/${model}` },
		// Pattern D: AI Gateway URL with workers-ai provider, named gateway
		{ label: `D: gateway/${CF_GATEWAY}/workers-ai`,
		  url: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/${CF_GATEWAY}/workers-ai/${model}` },
		// Pattern E: AI Gateway URL with @cf/workers-ai provider naming
		{ label: 'E: gateway/default/compat',
		  url: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/default/compat/${model}` },
	];
}

console.log(`Probing partner-model URL patterns on account ${CF_ACCOUNT}`);
console.log(`Gateway name (env CF_GATEWAY_ID or default): ${CF_GATEWAY}`);
console.log('');

for (const model of TEST_MODELS) {
	console.log(`=== Model: ${model} ===`);
	for (const { label, url } of urlPatterns(model)) {
		const start = Date.now();
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'reply with one word: pong' }],
					max_tokens: 20,
				}),
			});
			const latency = Date.now() - start;
			const txt = await res.text();
			let summary = '';
			if (res.ok) {
				try {
					const j = JSON.parse(txt);
					// Try multiple response shapes
					let output = '';
					if (j.success === false) {
						summary = `!success: ${JSON.stringify(j.errors || {}).slice(0, 100)}`;
					} else if (j.result?.response) {
						output = j.result.response;
						summary = `OK (cf result.response): "${output.slice(0, 30)}"`;
					} else if (j.result?.content?.[0]?.text) {
						output = j.result.content[0].text;
						summary = `OK (anthropic-shape result.content): "${output.slice(0, 30)}"`;
					} else if (j.content?.[0]?.text) {
						output = j.content[0].text;
						summary = `OK (anthropic-shape direct): "${output.slice(0, 30)}"`;
					} else if (j.choices?.[0]?.message?.content) {
						output = j.choices[0].message.content;
						summary = `OK (openai-shape): "${output.slice(0, 30)}"`;
					} else if (j.result?.choices?.[0]?.message?.content) {
						output = j.result.choices[0].message.content;
						summary = `OK (cf+openai-shape): "${output.slice(0, 30)}"`;
					} else {
						summary = `OK but unknown shape: ${JSON.stringify(j).slice(0, 120)}`;
					}
				} catch (e) {
					summary = `parse-error: ${txt.slice(0, 80)}`;
				}
			} else {
				let reason = `HTTP ${res.status}`;
				try {
					const j = JSON.parse(txt);
					reason = j.errors?.[0]?.message || j.error?.message || txt.slice(0, 100);
				} catch {}
				summary = `FAIL [${res.status}] ${reason.slice(0, 120)}`;
			}
			console.log(`  ${label.padEnd(35)} ${latency.toString().padStart(5)}ms  ${summary}`);
		} catch (err) {
			console.log(`  ${label.padEnd(35)} ${(Date.now() - start).toString().padStart(5)}ms  ERR ${err.message?.slice(0, 100)}`);
		}
	}
	console.log('');
}

console.log('Use the first working pattern to update the bench script.');
console.log('Note the response shape — bench needs to know how to parse output for each provider.');
