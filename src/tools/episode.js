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


/**
 * Update Episode Outcome — lets Gemini close the loop on pending episodes.
 *
 * When Gemini follows up on a previous suggestion and learns whether it helped,
 * this tool updates the episode record with the actual outcome.
 */
export const updateEpisodeOutcomeTool = {
	definition: {
		name: "update_episode_outcome",
		description: `Update the outcome of a previous episode. Use this when following up on something you previously suggested or discussed, and now know whether it helped. For example, if you suggested a coping strategy last week and the user reports it worked, update the episode outcome to 'positive' with a lesson learned.`,
		parameters: {
			type: "OBJECT",
			properties: {
				episode_id: {
					type: "NUMBER",
					description: "The ID of the episode to update (from episode search results)"
				},
				outcome: {
					type: "STRING",
					enum: ["positive", "negative", "neutral"],
					description: "Did the intervention help? positive = it worked, negative = it didn't, neutral = unclear"
				},
				lesson: {
					type: "STRING",
					description: "What was learned from this outcome? What to do differently or continue doing. (1 sentence)"
				}
			},
			required: ["episode_id", "outcome"]
		}
	},
	async execute(args, env, context) {
		const { updateEpisodeOutcome } = await import('../services/episodeStore');
		await updateEpisodeOutcome(env, args.episode_id, args.outcome, args.lesson || null);
		return {
			status: "updated",
			message: `Episode ${args.episode_id} outcome updated to '${args.outcome}'. This will inform future responses.`
		};
	}
};
