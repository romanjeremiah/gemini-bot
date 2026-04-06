/**
 * Generates an Ogg Opus buffer from text using Google Cloud TTS.
 */
export async function generateSpeech(text, personaKey, env) {
	const voices = {
		gemini: "en-US-Chirp3-HD-Gacrux",
		thinking_partner: "en-US-Chirp3-HD-Vindemiatrix",
		honest_friend: "en-US-Chirp3-HD-Autonoe",
		hue: "en-US-Chirp3-HD-Zubenelgenubi",
		default: "en-US-Chirp3-HD-Gacrux"
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

	const binary = atob(data.audioContent);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
