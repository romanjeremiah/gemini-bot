// _probe_judge.mjs
// Reproduce one judge call exactly as the bench does, capture actual error.
//
// Run: node _probe_judge.mjs

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || 'bc6018c200086c59663c8ff798e689fa';
const CF_GATEWAY_ID = process.env.CF_GATEWAY_ID || 'gemini-bot';
const CF_AIG_TOKEN = process.env.CF_AIG_TOKEN;
if (!CF_AIG_TOKEN) { console.error('CF_AIG_TOKEN missing'); process.exit(1); }

const UNIFIED_ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/compat/chat/completions`;

const JUDGE_SYSTEM = `You are an expert evaluator of conversational AI responses for a personal Telegram companion called Xaridotis. Your job is to score a single response on four dimensions.

Score each dimension 1-5 where 1=poor, 3=acceptable, 5=excellent. Be strict.

Output ONLY a valid JSON object with this exact structure:
{
  "persona_fit": <1-5>,
  "persona_fit_reason": "<one sentence>",
  "grounded": <1-5>,
  "grounded_reason": "<one sentence>",
  "length": <1-5>,
  "length_reason": "<one sentence>",
  "naturalness": <1-5>,
  "naturalness_reason": "<one sentence>"
}

No other text. No markdown. No code fences.`;

const userPrompt = `SCENARIO: Greeting / casual

CONVERSATION HISTORY:
USER: morning

CANDIDATE RESPONSE TO JUDGE:
Morning. Coffee on the cards?

Score the response on the four dimensions and return only the JSON object.`;

console.log(`Endpoint: ${UNIFIED_ENDPOINT}`);
console.log('');

// --- Test 1: exactly what bench did (system+user as messages array) ---
console.log('=== Test 1: system as message, max_tokens=600 ===');
{
	const body = {
		model: 'anthropic/claude-opus-4-7',
		messages: [
			{ role: 'system', content: JUDGE_SYSTEM },
			{ role: 'user', content: userPrompt },
		],
		max_tokens: 600,
		temperature: 0.2,
	};
	const start = Date.now();
	try {
		const res = await fetch(UNIFIED_ENDPOINT, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_AIG_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const latency = Date.now() - start;
		const txt = await res.text();
		console.log(`  HTTP ${res.status} in ${latency}ms`);
		console.log(`  Response (first 500c): ${txt.slice(0, 500)}`);
		if (res.ok) {
			try {
				const json = JSON.parse(txt);
				const content = json?.choices?.[0]?.message?.content || '';
				console.log(`  Extracted content (${content.length}c): ${content.slice(0, 400)}`);
			} catch (e) {
				console.log(`  Parse error: ${e.message}`);
			}
		}
	} catch (err) {
		console.log(`  EXCEPTION: ${err.message}`);
	}
}

console.log('');
console.log('=== Test 2: Same as Test 1 but with smaller max_tokens=400 ===');
{
	const body = {
		model: 'anthropic/claude-opus-4-7',
		messages: [
			{ role: 'system', content: JUDGE_SYSTEM },
			{ role: 'user', content: userPrompt },
		],
		max_tokens: 400,
		temperature: 0.2,
	};
	const start = Date.now();
	try {
		const res = await fetch(UNIFIED_ENDPOINT, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_AIG_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const latency = Date.now() - start;
		const txt = await res.text();
		console.log(`  HTTP ${res.status} in ${latency}ms`);
		console.log(`  Response (first 500c): ${txt.slice(0, 500)}`);
	} catch (err) {
		console.log(`  EXCEPTION: ${err.message}`);
	}
}

console.log('');
console.log('=== Test 3: Try claude-sonnet-4-6 (Anthropic native, see if it works) ===');
{
	const body = {
		model: 'anthropic/claude-sonnet-4-6',
		messages: [
			{ role: 'system', content: JUDGE_SYSTEM },
			{ role: 'user', content: userPrompt },
		],
		max_tokens: 600,
		temperature: 0.2,
	};
	const start = Date.now();
	try {
		const res = await fetch(UNIFIED_ENDPOINT, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_AIG_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const latency = Date.now() - start;
		const txt = await res.text();
		console.log(`  HTTP ${res.status} in ${latency}ms`);
		console.log(`  Response (first 500c): ${txt.slice(0, 500)}`);
	} catch (err) {
		console.log(`  EXCEPTION: ${err.message}`);
	}
}
