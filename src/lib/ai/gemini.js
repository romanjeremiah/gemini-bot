import { toolDefinitions } from '../../tools';

export async function getCompletion(history, systemInstruction, env) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${env.GEMINI_API_KEY}`;

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			system_instruction: { parts: [{ text: systemInstruction }] },
			contents: history,
			tools: [{ function_declarations: toolDefinitions }],
			generation_config: { temperature: 1.0, max_output_tokens: 1500 }
		})
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 200)}`);
	}

	const data = await res.json();
	const candidate = data.candidates?.[0];

	if (!candidate) {
		const blockReason = data.promptFeedback?.blockReason;
		throw new Error(blockReason ? `Blocked: ${blockReason}` : "Gemini returned no candidates");
	}

	if (candidate.finishReason === "SAFETY") {
		throw new Error("Response blocked by safety filters");
	}

	return data;
}
