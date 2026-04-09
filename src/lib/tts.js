/**
 * Generates an Ogg Opus buffer from text using Google Cloud TTS.
 */
export async function generateSpeech(text, personaKey, env) {
	const voices = {
		tenon:    "en-US-Chirp3-HD-Zubenelgenubi",
		nightfall: "en-US-Chirp3-HD-Gacrux",
		tribore:  "en-US-Chirp3-HD-Sadachbia",
		default:  "en-US-Chirp3-HD-Gacrux"
	};

	const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GCP_TTS_API_KEY}`;
	const payload = {
		input: { text },
		voice: { languageCode: "en-US", name: voices[personaKey] || voices.default },
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
