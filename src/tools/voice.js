export const voiceTool = {
	definition: {
		name: "send_voice_note",
		description: "Reply with a voice message. Use when user requests voice or the response benefits from spoken delivery.",
		parameters: {
			type: "OBJECT",
			properties: {
				text_to_speak: { type: "STRING" }
			},
			required: ["text_to_speak"]
		}
	},
	// Voice execution is handled directly in handlers.js (needs TTS + Telegram send)
	// This definition exists so Gemini knows the tool is available
	async execute(args, env, context) {
		return { status: "success", note: "Voice handled by handler" };
	}
};
