/**
 * Episode Tool — lets Gemini log structured episodes (CoALA episodic memory).
 *
 * Gemini calls this after significant conversations to record
 * what happened, what worked, and what was learned.
 */
export const episodeTool = {
	definition: {
		name: "save_episode",
		description: `Record a significant interaction as a structured episode in memory. Use this AFTER meaningful conversations to capture what happened and what was learned. Episode types:
- 'crisis': User expressed severe distress, suicidal thoughts, or danger signals
- 'breakthrough': User had an insight, shifted perspective, or experienced emotional release
- 'pattern': A recurring emotional or behavioural pattern was identified
- 'checkin': A mood check-in with notable clinical observations
- 'conversation': Any other significant exchange worth remembering

WHEN TO USE: After emotional conversations, therapy-like exchanges, significant personal revelations, or when you notice a pattern. Do NOT log trivial exchanges.`,
		parameters: {
			type: "OBJECT",
			properties: {
				episode_type: {
					type: "STRING",
					enum: ["crisis", "breakthrough", "pattern", "checkin", "conversation"],
					description: "The type of episode"
				},
				trigger: {
					type: "STRING",
					description: "What prompted this episode? What was the user dealing with? (1-2 sentences)"
				},
				emotions: {
					type: "ARRAY",
					items: { type: "STRING" },
					description: "Emotions present during the episode (e.g. ['anxious', 'lonely', 'hopeful'])"
				},
				intervention: {
					type: "STRING",
					description: "What did you do or suggest? What approach did you take? (1-2 sentences)"
				},
				outcome: {
					type: "STRING",
					enum: ["positive", "negative", "neutral", "pending"],
					description: "How did it resolve? Did the user feel better, worse, or unchanged?"
				},
				lesson: {
					type: "STRING",
					description: "What was learned for future reference? What should you remember to do (or avoid) next time? (1 sentence)"
				},
				mood_score: {
					type: "NUMBER",
					description: "Mood score at time of episode (0-10) if available"
				}
			},
			required: ["episode_type", "trigger"]
		}
	},
	async execute(args, env, context) {
		const { saveEpisode } = await import('../services/episodeStore');
		await saveEpisode(env, context.chatId, {
			type: args.episode_type,
			trigger: args.trigger,
			emotions: args.emotions || [],
			intervention: args.intervention,
			outcome: args.outcome,
			lesson: args.lesson,
			moodScore: args.mood_score,
		});
		return {
			status: "saved",
			message: "Episode recorded. This will help me remember what worked and what to do differently next time."
		};
	}
};
