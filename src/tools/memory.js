import * as memoryStore from '../services/memoryStore';

export const memoryTool = {
	definition: {
		name: "save_memory",
		description: "Save an important fact, observation, idea, or thought dump about the person you're talking to. Write facts in SECOND PERSON using 'you/your' (e.g. 'You go to the gym on weekday mornings', 'You are allergic to peanuts'). Do NOT narrate in third person ('Roman goes to...', 'He is allergic...'). ALL times in 24-hour format (20:00, NOT '8 PM'). Categories: preference, personal, work, hobby, identity, relationship, health, habit, pattern (recurring behaviour/emotional pattern), trigger (emotional/situational trigger), avoidance (things they avoid), schema (core belief or narrative), growth (positive change or breakthrough), coping (coping strategy, healthy or unhealthy), insight (self-awareness moment), idea (a creative idea, project concept, or plan worth preserving), brain_dump (raw unstructured thoughts that you should synthesise into a clean, logical note before saving), discovery (interesting news, research findings, or tech developments), architecture_spec (technical architecture maps or code structure summaries for the bot itself). Set importance to 2 or 3 for therapeutic observations that represent significant patterns or breakthroughs.",
		parameters: {
			type: "OBJECT",
			properties: {
				category: {
					type: "STRING",
					description: "One of: preference, personal, work, hobby, identity, relationship, health, habit, pattern, trigger, avoidance, schema, growth, coping, insight, idea, brain_dump"
				},
				fact: {
					type: "STRING",
					description: "The fact or observation to remember. Write in SECOND PERSON: 'You are allergic to peanuts', 'You prefer 24h time formats', 'You went rollerblading in Richmond Park on 15 Apr'. NEVER use third person ('Roman is...', 'He prefers...'). NEVER use generic 'User'. ALL times in 24-hour format (13:00, NOT '1 PM'). For therapeutic categories, be specific and include context."
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
		await memoryStore.saveMemory(env, context.userId, args.category, args.fact, importance);
		return { status: "success", category: args.category, importance };
	}
};
