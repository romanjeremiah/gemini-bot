// AI Model Router.
//
// Decides which provider + model handles each message. The router is the
// single decision point — every other part of handlers.js talks to the
// returned AIProvider, never to a specific model directly.
//
// Routing policy:
//   - Multimodal (voice/image/video/audio)  → Gemini Pro (CF AI is text-only)
//   - Active health check-in                  → Gemini Pro (therapeutic depth)
//   - Emotional/therapeutic content           → Gemini Pro
//   - Code / architectural / analytical       → Qwen3 30B (CF, free, strong reasoning)
//   - Long messages (>300 chars)              → Qwen3 30B
//   - Casual chat / acknowledgements          → Gemma 4 (CF, free, fast) — DEFAULT
//
// Why default to Gemma:
//   ~80% of messages are casual. Routing them to free Gemma instead of
//   paid Flash-Lite avoids Gemini preview overload (the cause of the
//   silent morning check-ins) AND saves cost. Gemma 4 is a recent
//   instruction-tuned 26B model with good system-prompt adherence —
//   the same `systemInstruction` we build for Gemini works here.

import { CloudflareProvider } from './cloudflare';
import { GeminiProvider } from './gemini-provider';
import { CF_MODELS, GEMINI_MODELS, COMPLEXITY_PATTERNS } from '../config/models';

/**
 * Decide which provider+model to use for this message.
 * @returns {{provider:'gemini'|'cloudflare', model:string, thinkingEffort:'low'|'medium'|'high', reason:string, isDefault:boolean}}
 */
export function routeMessage(ctx) {
	const { userText, healthCheckinActive, hasMedia } = ctx;

	if (hasMedia) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, thinkingEffort: 'medium', reason: 'multimodal_input', isDefault: false };
	}

	if (healthCheckinActive) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, thinkingEffort: 'high', reason: 'active_health_checkin', isDefault: false };
	}

	if (COMPLEXITY_PATTERNS.emotional.test(userText)) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, thinkingEffort: 'medium', reason: 'emotional_content', isDefault: false };
	}

	if (COMPLEXITY_PATTERNS.code.test(userText) || /```/.test(userText)) {
		return { provider: 'cloudflare', model: CF_MODELS.code, thinkingEffort: 'high', reason: 'code_content', isDefault: false };
	}

	if (COMPLEXITY_PATTERNS.analytical.test(userText)) {
		return { provider: 'cloudflare', model: CF_MODELS.code, thinkingEffort: 'medium', reason: 'analytical_content', isDefault: false };
	}

	if ((userText || '').length > 300) {
		return { provider: 'cloudflare', model: CF_MODELS.code, thinkingEffort: 'medium', reason: 'long_message', isDefault: false };
	}

	// Default casual route
	return { provider: 'cloudflare', model: CF_MODELS.chat, thinkingEffort: 'low', reason: 'default_casual', isDefault: true };
}

/**
 * Create the AIProvider instance for the chosen route.
 */
export function createProvider(route, env) {
	if (route.provider === 'gemini') return new GeminiProvider(env, route.model);
	return new CloudflareProvider(env.AI, route.model);
}

/**
 * Convenience: route + create + log (only for non-default routes — keeps tail clean).
 */
export function getProvider(ctx, env, log) {
	const route = routeMessage(ctx);
	const provider = createProvider(route, env);
	if (!route.isDefault && log) {
		log.info('model_route', {
			provider: route.provider,
			model: route.model,
			thinking: route.thinkingEffort,
			reason: route.reason,
		});
	}
	return { provider, route };
}
