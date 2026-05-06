// Pre-flight transcription helper for voice / audio media.
//
// Why this exists: voice notes arrive with empty userText. The router and
// memory filter regexes need text to make smart decisions. Without a
// transcript, every voice note looked identical to the routing layer
// ("empty string") and got routed by hasMedia rules alone.
//
// Phase C splices a Flash-Lite transcription call into handlers.js BEFORE
// routing runs. The transcript is appended to userText so all downstream
// signals — register classifier, memory filter, conversation tagger,
// route selector — see the actual content.
//
// The audio itself is STILL passed to the main response model in userParts.
// Transcription is for routing/context only, not a replacement for audio.
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

const TRANSCRIBE_PROMPT = 'Transcribe this audio recording. Output ONLY the spoken words as plain text. No timestamps, no speaker labels, no commentary, no markdown.';
const SYSTEM_PROMPT = 'You are a speech-to-text transcriber. Return only the transcribed text, nothing else.';

// Per-call timeout. Voice notes are typically 5-60s of audio; transcription
// usually completes in 1-3s. Cap at 8s so we don’t blow the message budget
// if Gemini stalls. On timeout the caller proceeds without a transcript.
const TRANSCRIBE_TIMEOUT_MS = 8000;

/**
 * Transcribe base64-encoded audio using Gemini Flash-Lite.
 *
 * @param {object} env - Worker env with GEMINI_API_KEY
 * @param {string} base64Audio - Audio bytes as base64
 * @param {string} mimeType - Audio mime type (audio/ogg, audio/mp4, etc.)
 * @returns {Promise<{success: boolean, text: string, latency_ms: number, error?: string}>}
 */
export async function transcribeAudio(env, base64Audio, mimeType) {
	const t0 = Date.now();

	if (!env.GEMINI_API_KEY) {
		return { success: false, text: '', latency_ms: 0, error: 'no_api_key' };
	}
	if (!base64Audio || !mimeType) {
		return { success: false, text: '', latency_ms: 0, error: 'no_audio' };
	}

	try {
		const ai = getAI(env);
		const gen = ai.models.generateContent({
			model: FLASH_LITE_TEXT_MODEL,
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

		// Wall-clock timeout via Promise.race. The SDK doesn’t support
		// AbortController on this version cleanly, so a race is the simplest
		// way to bound latency without leaking the original request.
		let timedOut = false;
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => {
				timedOut = true;
				reject(new Error('transcription_timeout'));
			}, TRANSCRIBE_TIMEOUT_MS);
		});

		const response = await Promise.race([gen, timeoutPromise]);
		if (timedOut) {
			return { success: false, text: '', latency_ms: Date.now() - t0, error: 'timeout' };
		}

		// Prefer SDK’s .text accessor when available; fall back to manual
		// parts walking for older SDK versions. Filter out thought parts.
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
		log.warn('transcribe_failed', {
			msg: (err.message || '').slice(0, 200),
			status: err.status,
			latency_ms: latency,
		});
		return { success: false, text: '', latency_ms: latency, error: err.message?.slice(0, 100) };
	}
}
