export const imageTool = {
	definition: {
		name: "generate_image",
		description: "Generate or edit an image using AI. Use when the user asks to create, draw, generate, or make any image, picture, photo, diagram, illustration, logo, icon, sticker, meme, or wallpaper. Also use when the user uploads an image and asks to edit, modify, change, or transform it. Pass the full creative request as the prompt. Set edit_mode to true if the user uploaded an image and wants it edited.",
		parameters: {
			type: "OBJECT",
			properties: {
				prompt: {
					type: "STRING",
					description: "Detailed description of the image to generate or the edit to apply."
				},
				edit_mode: {
					type: "BOOLEAN",
					description: "Set to true if editing an uploaded image, false or omit for new generation."
				}
			},
			required: ["prompt"]
		}
	},
	// Image generation is handled directly in handlers.js (needs access to uploaded media).
	// This execute is a no-op — the tool definition exists so Gemini knows to call it.
	async execute() {
		return { status: "success", note: "Image handled by handler" };
	}
};
