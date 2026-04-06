import * as memoryStore from '../services/memoryStore';

export const memoryTool = {
	definition: {
		name: "save_memory",
		description: "Save an important fact about the user for future reference.",
		parameters: {
			type: "OBJECT",
			properties: {
				category: { type: "STRING", description: "Category: preference, personal, work, health, etc." },
				fact: { type: "STRING" }
			},
			required: ["category", "fact"]
		}
	},
	async execute(args, env, context) {
		await memoryStore.saveMemory(env, context.chatId, args.category, args.fact);
		return { status: "success" };
	}
};
