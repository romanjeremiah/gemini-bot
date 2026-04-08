import { toolDefinitions } from '../../tools';

const PRIMARY_TEXT_MODEL = "gemini-3.1-pro-preview";
const PRIMARY_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const FALLBACK_IMAGE_MODEL = "gemini-2.5-flash-image";

async function fetchWithRetry(url, options, maxRetries = 3) {
	let lastError;
	for (let i = 0; i < maxRetries; i++) {
		try {
			const res = await fetch(url, options);
			if (res.status === 503 || res.status === 429) {
				await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
				continue;
			}
			return res;
		} catch (err) { lastError = err; }
	}
	throw lastError || new Error("Max retries reached");
}

// ---- Standard Completion ----
export async function getCompletion(history, systemInstruction, env) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_TEXT_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
	const res = await fetchWithRetry(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: systemInstruction }] },
			contents: history,
			tools: [
				{ functionDeclarations: toolDefinitions },
				{ googleSearch: {} }
			],
			toolConfig: { includeServerSideToolInvocations: true },
			generationConfig: { temperature: 1.0, maxOutputTokens: 8192 }
		})
	});
	if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = await res.json();
	const candidate = data.candidates?.[0];
	if (!candidate) {
		const blockReason = data.promptFeedback?.blockReason;
		throw new Error(blockReason ? `Blocked: ${blockReason}` : "Gemini returned no candidates");
	}
	if (candidate.finishReason === "SAFETY") throw new Error("Response blocked by safety filters");
	if (candidate.content?.parts) {
		candidate.content.parts = candidate.content.parts.filter(p => !(p.functionCall && p.functionCall.name === "googleSearch"));
	}
	return data;
}

// ---- Streaming Completion (Live typing & Google Search) ----
export async function* streamCompletion(history, systemInstruction, env) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_TEXT_MODEL}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: systemInstruction }] },
			contents: history,
			tools: [
				{ functionDeclarations: toolDefinitions },
				{ googleSearch: {} }
			],
			toolConfig: { includeServerSideToolInvocations: true },
			generationConfig: { temperature: 1.0, maxOutputTokens: 8192 }
		})
	});

	if (!res.ok) throw new Error(`Gemini Stream API ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const events = buffer.split(/\r?\n\r?\n/);
		buffer = events.pop() || "";

		for (const event of events) {
			const dataStr = event.trim().split(/\r?\n/).map(l => l.replace(/^data:\s*/, '')).join('').trim();
			if (dataStr === '[DONE]') return;
			try {
				const candidate = JSON.parse(dataStr).candidates?.[0];
				if (!candidate) continue;

				const textPart = candidate.content?.parts?.find(p => p.text);
				if (textPart?.text) yield { type: 'text', text: textPart.text };

				const calls = candidate.content?.parts?.filter(p => p.functionCall && p.functionCall.name !== "googleSearch");
				if (calls?.length) yield { type: 'functionCall', calls };

				if (candidate.groundingMetadata) yield { type: 'groundingMetadata', metadata: candidate.groundingMetadata };
			} catch (e) {}
		}
	}

	if (buffer.trim() && buffer.trim() !== '[DONE]') {
		try {
			const dataStr = buffer.split(/\r?\n/).map(l => l.replace(/^data:\s*/, '')).join('').trim();
			const candidate = JSON.parse(dataStr).candidates?.[0];
			if (candidate) {
				const textPart = candidate.content?.parts?.find(p => p.text);
				if (textPart?.text) yield { type: 'text', text: textPart.text };
			}
		} catch (e) {}
	}
}

// ---- Image Generation / Editing (Nano Banana 2) ----
export async function generateImage(prompt, env, inputImageBase64 = null, inputMimeType = null, useFallback = false) {
	const model = useFallback ? FALLBACK_IMAGE_MODEL : PRIMARY_IMAGE_MODEL;
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

	const parts = [];
	if (inputImageBase64 && inputMimeType) {
		parts.push({ inlineData: { mimeType: inputMimeType, data: inputImageBase64 } });
	}
	parts.push({ text: prompt });

	console.log(`🎨 Image gen request to ${model}`);

	const res = await fetchWithRetry(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts }],
			generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
		})
	});

	if (!res.ok) {
		const errText = (await res.text()).slice(0, 300);
		console.error("🎨 Image API error:", errText);
		if ((res.status === 503 || res.status === 429) && !useFallback) {
			console.log("🎨 Falling back to", FALLBACK_IMAGE_MODEL);
			return generateImage(prompt, env, inputImageBase64, inputMimeType, true);
		}
		throw new Error(`Image API ${res.status}: ${errText.slice(0, 200)}`);
	}

	const data = await res.json();
	const candidate = data.candidates?.[0];

	if (!candidate) {
		const blockReason = data.promptFeedback?.blockReason;
		console.error("🎨 No candidate. Feedback:", JSON.stringify(data.promptFeedback));
		throw new Error(blockReason ? `Blocked: ${blockReason}` : "Image generation returned no result");
	}

	if (candidate.finishReason === "SAFETY") throw new Error("Image blocked by safety filters");

	let imageBase64 = null, mimeType = null, caption = "";
	for (const part of candidate.content?.parts || []) {
		if (part.inlineData) { imageBase64 = part.inlineData.data; mimeType = part.inlineData.mimeType || "image/png"; }
		else if (part.text) caption += part.text;
	}

	if (!imageBase64) {
		console.error("🎨 No image in parts:", JSON.stringify(candidate.content?.parts?.map(p => Object.keys(p))));
		throw new Error("No image was generated. Try a different prompt.");
	}

	console.log("🎨 Image generated, mime:", mimeType, "size:", imageBase64.length);
	return { imageBase64, mimeType, caption };
}
