import * as memoryStore from '../services/memoryStore';

export const memoryTool = {
	definition: {
		name: "save_memory",
		description: "Save an important fact or observation about the user for long-term reference. Use freely for both casual facts and therapeutic insights. Categories: preference, personal, work, hobby, identity, relationship, health, habit, pattern (recurring behaviour/emotional pattern), trigger (emotional/situational trigger), avoidance (things the user avoids), schema (core belief or narrative), growth (positive change or breakthrough), coping (coping strategy, healthy or unhealthy), insight (self-awareness moment). Set importance to 2 or 3 for therapeutic observations that represent significant patterns or breakthroughs.",
		parameters: {
			type: "OBJECT",
			properties: {
				category: {
					type: "STRING",
					description: "One of: preference, personal, work, hobby, identity, relationship, health, habit, pattern, trigger, avoidance, schema, growth, coping, insight"
				},
				fact: {
					type: "STRING",
					description: "The fact or observation to remember. For therapeutic categories, be specific and include context."
				},
				importance: {
					type: "INTEGER",
					description: "1 = normal fact, 2 = notable therapeutic observation, 3 = significant pattern or breakthrough. Default 1."
				}
			},
			required: ["category", "fact"]
		}
	},
	async execute(args, env, context) {
		const importance = args.importance || 1;
		await memoryStore.saveMemory(env, context.chatId, args.category, args.fact, importance);
		return { status: "success", category: args.category, importance };
	}
};
