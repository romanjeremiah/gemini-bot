/**
 * Generates an Ogg Opus buffer from text using Google Cloud TTS (Chirp 3: HD).
 */
import { resolveVoice } from '../config/voices';

export async function generateSpeech(text, personaKey, env, userVoiceOverride = null) {
	const voiceName = resolveVoice(personaKey, userVoiceOverride);
	const locale = voiceName.split('-').slice(0, 2).join('-');

	const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GCP_TTS_API_KEY}`;
	const payload = {
		input: { text },
		voice: { languageCode: locale, name: voiceName },
		audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 24000 }
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});

	const data = await res.json();
	if (!data.audioContent) throw new Error("TTS Generation Failed");

	const { Buffer } = await import('node:buffer');
	return Buffer.from(data.audioContent, 'base64').buffer;
}
