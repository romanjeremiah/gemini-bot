// AI Gateway wrapper.
//
// Routes both Cloudflare Workers AI and Gemini through Cloudflare AI Gateway
// (gateway.ai.cloudflare.com) for: analytics dashboard, response caching (5-min
// TTL), unified rate limiting, and a single observability surface across
// providers.
//
// Falls back to direct invocation if the gateway is unavailable so a misconfigured
// gateway never silently breaks the bot.
//
// Setup:
//   1. Cloudflare dashboard → AI → AI Gateway → create gateway named "xaridotis"
//   2. wrangler.jsonc: ai = { binding = "AI" } (already set)
//   3. Optional: set GEMINI_GATEWAY_URL secret to enable Gemini-via-gateway routing.
//      Format: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/google-ai-studio
//      If unset, Gemini calls go direct.

const GATEWAY_ID = 'xaridotis';
const CACHE_TTL_SECONDS = 300; // 5 min

/**
 * Run a Cloudflare Workers AI model through the gateway when possible.
 * Wraps env.AI.run() with gateway routing. Falls back to direct call on
 * any gateway-side error so the bot never fails because the gateway is down.
 */
export async function runCfAi(env, model, input, opts = {}) {
	if (!env.AI) {
		throw new Error('runCfAi: env.AI binding missing');
	}
	const gatewayConfig = {
		gateway: {
			id: GATEWAY_ID,
			skipCache: opts.skipCache === true,
			cacheTtl: opts.cacheTtl ?? CACHE_TTL_SECONDS,
		},
	};
	try {
		return await env.AI.run(model, input, gatewayConfig);
	} catch (err) {
		// If the gateway itself is the problem (e.g. "gateway not found"),
		// retry without it so the call still goes through. We log so we
		// know the gateway is misconfigured.
		const msg = (err && err.message) || '';
		if (msg.includes('gateway') || msg.includes('Gateway')) {
			console.warn('AI gateway error, falling back to direct AI.run:', msg);
			return await env.AI.run(model, input);
		}
		throw err;
	}
}

/**
 * Build the base URL for routing Gemini calls through the gateway.
 * Returns null if no gateway URL is configured — caller should use the
 * direct Gemini SDK in that case.
 */
export function geminiGatewayUrl(env) {
	return env.GEMINI_GATEWAY_URL || null;
}
