export const imageTool = {
	definition: {
		name: "generate_image",
		description: `Generate or edit an image using AI. Use when the user asks to create, draw, generate, or make any image, picture, photo, diagram, illustration, logo, icon, meme, or wallpaper. Also use when the user uploads an image and asks to edit, modify, change, or transform it. Pass the full creative request as the prompt. Set edit_mode to true if the user uploaded an image and wants it edited.

STICKER CREATION: If the user asks you to create a 'sticker', append this to your prompt: 'die-cut sticker style, flat vector illustration, thick white border, isolated on a solid white background, no shadows'. This produces sticker-ready images that can be added to Telegram sticker packs.`,
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
	async execute() {
		return { status: "success", note: "Image handled by handler" };
	}
};
