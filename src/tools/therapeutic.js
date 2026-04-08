import * as therapeuticStore from '../services/therapeuticStore';

export const saveTherapeuticNoteTool = {
	definition: {
		name: "save_therapeutic_note",
		description: `Save a therapeutic observation, pattern, or session note for long-term tracking. Use this proactively during conversations to record:
- PATTERN: Recurring emotional, behavioural, or relationship patterns you notice
- SCHEMA: Core schema activations (abandonment, defectiveness, emotional deprivation, etc.)
- AVOIDANCE: Topics or emotions the user deflects from or moves past quickly
- HOMEWORK: Exercises or reflections you have suggested, so you can follow up later
- SESSION: Key themes, breakthroughs, or shifts from a conversation
- TRIGGER: Identified emotional triggers and their context
- GROWTH: Moments of vulnerability, insight, or positive change worth reinforcing`,
		parameters: {
			type: "OBJECT",
			properties: {
				note_type: {
					type: "STRING",
					enum: ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"],
					description: "The category of therapeutic observation"
				},
				content: {
					type: "STRING",
					description: "The observation itself. Be specific and include context: what was said, what you noticed, what feeling was present."
				},
				tags: {
					type: "ARRAY",
					items: { type: "STRING" },
					description: "Short tags for cross-referencing, e.g. ['jordan', 'work', 'self-worth', 'anger']"
				}
			},
			required: ["note_type", "content"]
		}
	},
	async execute(args, env, context) {
		await therapeuticStore.saveNote(env, context.chatId, args.note_type, args.content, args.tags || []);
		return { status: "success", saved: args.note_type };
	}
};

export const getTherapeuticNotesTool = {
	definition: {
		name: "get_therapeutic_notes",
		description: `Retrieve previous therapeutic observations and session notes. Use this at the start of conversations to refresh your understanding of ongoing patterns, active schemas, pending homework, and recent session themes. Also use mid-conversation when you sense a connection to a previously noted pattern.`,
		parameters: {
			type: "OBJECT",
			properties: {
				note_type: {
					type: "STRING",
					enum: ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"],
					description: "Filter by type. Omit to retrieve all types."
				},
				limit: {
					type: "INTEGER",
					description: "Number of notes to retrieve. Default 15."
				}
			},
			required: []
		}
	},
	async execute(args, env, context) {
		const notes = await therapeuticStore.getNotes(env, context.chatId, args.note_type || null, args.limit || 15);
		if (!notes.length) return { status: "success", notes: [], message: "No therapeutic notes found." };
		return { status: "success", notes };
	}
};
