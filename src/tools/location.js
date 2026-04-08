import * as telegram from '../lib/telegram';

export const locationTool = {
	definition: {
		name: "send_location",
		description: "Pin a geographical location on a map for the user. Use this when recommending places, restaurants, or meeting points.",
		parameters: {
			type: "OBJECT",
			properties: {
				latitude: { type: "NUMBER" },
				longitude: { type: "NUMBER" }
			},
			required: ["latitude", "longitude"]
		}
	},
	async execute(args, env, context) {
		await telegram.sendLocation(context.chatId, context.threadId, args.latitude, args.longitude, env);
		return { status: "success" };
	}
};
