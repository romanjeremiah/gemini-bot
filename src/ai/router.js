// AI Model Router.
//
// Decides which provider + model handles each message. The router is the
// single decision point — every other part of handlers.js trusts the
// returned { provider, model } and never picks a model independently.
//
// Routing priority (highest first):
//   1. modelOverride (user-explicit /model command)        → chosen Gemini tier
//   2. mode === 'crisis' (tagger)                          → Gemini Pro
//   3. hasMedia (image/video/audio)                        → Gemini Pro (CF is text-only)
//   4. mode === 'venting' (tagger)                         → Gemini Pro (warm register)
//   5. healthCheckinActive + emotional regex match         → Gemini Pro
//   6. emotional regex match (no check-in)                 → Gemini Pro
//   7. mode === 'processing' (tagger)                      → Gemini Flash
//   8. complex task (detectComplexTask: code, analytical)  → Gemini Pro
//   9. CF code/analytical/long routes                      → Gemma 4 (CF)
//  10. simple message OR mode === 'transactional'          → Gemini Flash-Lite
//  11. default casual                                      → Gemma 4 (CF, default)
//
// Notes on Pro distribution:
//   - Rule 8 catches code/architecture/analytical text — these stay on Pro for
//     reasoning depth even though no emotional content. The earlier CF routes
//     for code/analytical were observability-only (same model as default casual);
//     keeping Pro here matches the previous parallel ternary in handlers.js
//     so behavioural parity is preserved.
//
// Mode integration:
//   The conversation tagger (cfAi.tagConversationMode) returns one of
//   'crisis' | 'venting' | 'processing' | 'transactional'. When it's
//   available the caller passes it in via ctx.mode; the router uses it as
//   a strong signal alongside the regex heuristics. When the tagger fails
//   or returns null, regex rules still cover the cases.

import { CloudflareProvider } from './cloudflare';
import { GeminiProvider } from './gemini-provider';
import { CF_MODELS, GEMINI_MODELS, COMPLEXITY_PATTERNS } from '../config/models';
import { detectComplexTask, isSimpleMessage } from './complexity';

/**
 * Decide which provider+model to use for this message.
 *
 * @param {object} ctx
 * @param {string} ctx.userText - Current user message (with transcript appended if voice)
 * @param {boolean} ctx.hasMedia - Image / video / audio attached to this message
 * @param {boolean} ctx.healthCheckinActive - User is mid-check-in (morning/midday/evening)
 * @param {string|null} ctx.mode - Tagger output: 'crisis'|'venting'|'processing'|'transactional'
 * @param {string|null} ctx.modelOverride - User ‘/model’ selection: gemini model string or null
 * @returns {{provider:'gemini'|'cloudflare', model:string, reason:string, isDefault:boolean}}
 */
export function routeMessage(ctx) {
	const { userText, healthCheckinActive, hasMedia, mode, modelOverride } = ctx;

	// 1. Explicit user override always wins.
	if (modelOverride) {
		return { provider: 'gemini', model: modelOverride, reason: 'user_override', isDefault: false };
	}

	// 2. Crisis from tagger — highest non-override priority.
	if (mode === 'crisis') {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'mode_crisis', isDefault: false };
	}

	// 3. Multimodal: Pro is the only path that can read images/audio/video.
	if (hasMedia) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'multimodal_input', isDefault: false };
	}

	// 4. Venting from tagger — needs warm register, not transactional reply.
	if (mode === 'venting') {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'mode_venting', isDefault: false };
	}

	// 5. Active check-in + emotional content — user is processing during the
	// check-in flow, deserves Pro depth.
	if (healthCheckinActive && COMPLEXITY_PATTERNS.emotional.test(userText || '')) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'checkin_with_emotion', isDefault: false };
	}

	// 6. Emotional content (no check-in active).
	if (COMPLEXITY_PATTERNS.emotional.test(userText || '')) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'emotional_content', isDefault: false };
	}

	// 7. Tagger says ‘processing’ — substantive but not emotional.
	// Flash is the right level: more reasoning than Flash-Lite, less weight than Pro.
	if (mode === 'processing') {
		return { provider: 'gemini', model: GEMINI_MODELS.flash, reason: 'mode_processing', isDefault: false };
	}

	// 8. Complex tasks (code, architecture, analytical, long) — Pro.
	// Note: this catches code/analytical text that the regex below would also
	// match. detectComplexTask wins because Pro reasoning matters more than
	// the CF cost saving for these. Order is deliberate.
	if (detectComplexTask(userText || '')) {
		return { provider: 'gemini', model: GEMINI_MODELS.pro, reason: 'complex_task', isDefault: false };
	}

	// 9. CF observability routes (kept for tail visibility; same model as default).
	if (COMPLEXITY_PATTERNS.code.test(userText || '') || /```/.test(userText || '')) {
		return { provider: 'cloudflare', model: CF_MODELS.chat, reason: 'code_content', isDefault: false };
	}
	if (COMPLEXITY_PATTERNS.analytical.test(userText || '')) {
		return { provider: 'cloudflare', model: CF_MODELS.chat, reason: 'analytical_content', isDefault: false };
	}
	if ((userText || '').length > 300) {
		return { provider: 'cloudflare', model: CF_MODELS.chat, reason: 'long_message', isDefault: false };
	}

	// 10. Simple message OR transactional mode — Flash-Lite is plenty.
	// Health check-in non-emotional replies (“took my meds”) land here too.
	if (mode === 'transactional' || healthCheckinActive || isSimpleMessage(userText || '')) {
		const reason = mode === 'transactional' ? 'mode_transactional'
			: healthCheckinActive ? 'checkin_simple_reply'
			: 'simple_message';
		return { provider: 'gemini', model: GEMINI_MODELS.flashLite, reason, isDefault: false };
	}

	// 11. Default: casual chat — Gemma on CF (free, fast, unlogged).
	return { provider: 'cloudflare', model: CF_MODELS.chat, reason: 'default_casual', isDefault: true };
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
			reason: route.reason,
		});
	}
	return { provider, route };
}
