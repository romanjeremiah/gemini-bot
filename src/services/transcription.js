// Pre-flight transcription helper for voice / audio media.
//
// Why this exists: voice notes arrive with empty userText. The router and
// memory filter regexes need text to make smart decisions. Without a
// transcript, every voice note looked identical to the routing layer
// ("empty string") and got routed by hasMedia rules alone.
//
// Phase C splices a transcription call into handlers.js BEFORE routing
// runs. The transcript is appended to userText so all downstream signals
// — register classifier, memory filter, conversation tagger, route selector
// — see the actual content.
//
// The audio itself is STILL passed to the main response model in userParts.
// Transcription is for routing/context only, not a replacement for audio.
//
// Architecture B+ (2026-05-14): Pro 3.1 preview is the primary transcription
// model per Roma's instruction. Audio capacity may differ from text capacity
// (text was 92-97% errors in the combined-eval bundle; audio is a separate
// API path). Flash-Lite 3.1 preview is the fallback — known working at ~3s.
//
// Failure mode: returns { success: false, text: '' }. Caller falls back to
// existing hasMedia routing (Pro for multimodal). No worse than current.

import { GoogleGenAI } from '@google/genai';
import { FLASH_LITE_TEXT_MODEL } from '../lib/ai/gemini';
import { log } from '../lib/logger';

let _ai = null;
function getAI(env) {
	if (!_ai) _ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	return _ai;
}

const TRANSCRIBE_PRIMARY_MODEL = 'gemini-3.1-pro-preview';
const TRANSCRIBE_FALLBACK_MODEL = FLASH_LITE_TEXT_MODEL; // 'gemini-3.1-flash-lite-preview'

const TRANSCRIBE_PROMPT = 'Transcribe this audio recording. Output ONLY the spoken words as plain text. No timestamps, no speaker labels, no commentary, no markdown.';
const SYSTEM_PROMPT = 'You are a speech-to-text transcriber. Return only the transcribed text, nothing else.';

// Per-call timeout. Voice notes are typically 5-60s of audio; transcription
// usually completes in 1-3s on Flash-Lite. Pro may run slower — we cap each
// tier independently. Worst case before falling back to no-transcript routing:
// 8s primary + 8s fallback = 16s. On timeout the caller proceeds without a
// transcript and routes via hasMedia rules.
const TRANSCRIBE_TIMEOUT_MS = 8000;

/**
 * Transcribe base64-encoded audio.
 *
 * Architecture B+ chain:
 *   1. gemini-3.1-pro-preview          (TRANSCRIBE_TIMEOUT_MS)
 *   2. gemini-3.1-flash-lite-preview   (TRANSCRIBE_TIMEOUT_MS) on primary failure
 *
 * @param {object} env - Worker env with GEMINI_API_KEY
 * @param {string} base64Audio - Audio bytes as base64
 * @param {string} mimeType - Audio mime type (audio/ogg, audio/mp4, etc.)
 * @returns {Promise<{success: boolean, text: string, latency_ms: number, model?: string, error?: string}>}
 */
export async function transcribeAudio(env, base64Audio, mimeType) {
	const t0 = Date.now();

	if (!env.GEMINI_API_KEY) {
		return { success: false, text: '', latency_ms: 0, error: 'no_api_key' };
	}
	if (!base64Audio || !mimeType) {
		return { success: false, text: '', latency_ms: 0, error: 'no_audio' };
	}

	// Tier 1: Pro 3.1 preview
	const primary = await tryTranscribeTier(env, TRANSCRIBE_PRIMARY_MODEL, base64Audio, mimeType, TRANSCRIBE_TIMEOUT_MS);
	if (primary.success) {
		log.info('transcribe_primary_ok', {
			model: TRANSCRIBE_PRIMARY_MODEL,
			latency_ms: primary.latency_ms,
			len: primary.text.length,
		});
		return { ...primary, latency_ms: Date.now() - t0, model: TRANSCRIBE_PRIMARY_MODEL };
	}

	log.warn('transcribe_primary_failed_falling_back', {
		model: TRANSCRIBE_PRIMARY_MODEL,
		error: primary.error,
		latency_ms: primary.latency_ms,
	});

	// Tier 2: Flash-Lite 3.1 preview (the previous default — known working)
	const fallback = await tryTranscribeTier(env, TRANSCRIBE_FALLBACK_MODEL, base64Audio, mimeType, TRANSCRIBE_TIMEOUT_MS);
	const totalMs = Date.now() - t0;
	if (fallback.success) {
		log.info('transcribe_fallback_ok', {
			model: TRANSCRIBE_FALLBACK_MODEL,
			latency_ms: fallback.latency_ms,
			total_ms: totalMs,
			len: fallback.text.length,
		});
		return { ...fallback, latency_ms: totalMs, model: TRANSCRIBE_FALLBACK_MODEL };
	}

	log.warn('transcribe_both_tiers_failed', {
		primary_error: primary.error,
		fallback_error: fallback.error,
		total_ms: totalMs,
	});
	return { success: false, text: '', latency_ms: totalMs, error: fallback.error || primary.error };
}

/**
 * Run one transcription tier with wall-clock timeout. Returns the same shape
 * as the public transcribeAudio but without the overall latency aggregate.
 * Never throws.
 */
async function tryTranscribeTier(env, model, base64Audio, mimeType, timeoutMs) {
	const t0 = Date.now();
	try {
		const ai = getAI(env);
		const gen = ai.models.generateContent({
			model,
			contents: [{
				role: 'user',
				parts: [
					{ inlineData: { mimeType, data: base64Audio } },
					{ text: TRANSCRIBE_PROMPT },
				],
			}],
			config: {
				systemInstruction: SYSTEM_PROMPT,
				// Temperature defaults to 1.0 (Roma's rule: never set explicit temp).
				// No maxOutputTokens cap (Roma's rule: never cap output). Voice notes
				// are short by nature — the SDK will return whatever the model produces.
			},
		});

		let timedOut = false;
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => {
				timedOut = true;
				reject(new Error('transcription_timeout'));
			}, timeoutMs);
		});

		const response = await Promise.race([gen, timeoutPromise]);
		if (timedOut) {
			return { success: false, text: '', latency_ms: Date.now() - t0, error: 'timeout' };
		}

		let text = '';
		if (typeof response?.text === 'string') {
			text = response.text;
		} else if (typeof response?.text === 'function') {
			try { text = response.text() || ''; } catch { /* fall through */ }
		}
		if (!text) {
			text = response?.candidates?.[0]?.content?.parts
				?.filter(p => p.text && !p.thought)
				?.map(p => p.text)
				?.join('') || '';
		}

		const trimmed = (text || '').trim();
		const latency = Date.now() - t0;

		if (!trimmed) {
			return { success: false, text: '', latency_ms: latency, error: 'empty_response' };
		}

		return { success: true, text: trimmed, latency_ms: latency };
	} catch (err) {
		const latency = Date.now() - t0;
		log.warn('transcribe_tier_failed', {
			model,
			msg: (err.message || '').slice(0, 200),
			status: err.status,
			latency_ms: latency,
		});
		return { success: false, text: '', latency_ms: latency, error: (err.message || 'unknown').slice(0, 100) };
	}
}
