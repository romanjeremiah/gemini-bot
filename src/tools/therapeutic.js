// Therapeutic tools now write to the unified `memories` table (Option A).
// Categories: pattern, schema, avoidance, homework, session, trigger, growth
// These map directly to the therapeutic categories in memoryStore.js.

import * as memoryStore from '../services/memoryStore';

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
					description: "The observation itself. Write in SECOND PERSON: 'You deflect to humour when grief surfaces', 'You avoid opening the laptop at 20:00 despite the pattern holding'. NEVER use third person ('Roman deflects...', 'He avoids...'). ALL times in 24-hour format (13:00, NOT '1 PM'). Be specific and include context."
				},
				importance: {
					type: "INTEGER",
					description: "1 = routine observation, 2 = notable pattern, 3 = significant breakthrough. Default 2."
				}
			},
			required: ["note_type", "content"]
		}
	},
	async execute(args, env, context) {
		const importance = args.importance || 2;
		await memoryStore.saveMemory(env, context.userId, args.note_type, args.content, importance);
		return { status: "success", saved: args.note_type, importance };
	}
};

export const getTherapeuticNotesTool = {
	definition: {
		name: "get_therapeutic_notes",
		description: `Retrieve previous therapeutic observations and session notes. Use at the start of conversations to refresh your understanding of ongoing patterns, active schemas, pending homework, and recent session themes. Also use mid-conversation when you sense a connection to a previously noted pattern.`,
		parameters: {
			type: "OBJECT",
			properties: {
				note_type: {
					type: "STRING",
					enum: ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"],
					description: "Filter by type. Omit to retrieve all therapeutic types."
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
		const therapeuticCategories = ["pattern", "schema", "avoidance", "homework", "session", "trigger", "growth"];

		if (args.note_type) {
			// Fetch a specific therapeutic category
			const notes = await memoryStore.getMemoriesByCategory(env, context.userId, args.note_type, args.limit || 15);
			if (!notes.length) return { status: "success", notes: [], message: `No ${args.note_type} notes found.` };
			return { status: "success", notes };
		}

		// Fetch all memories and filter to therapeutic categories
		const all = await memoryStore.getMemories(env, context.userId, args.limit || 30);
		const notes = all.filter(m => therapeuticCategories.includes(m.category));
		if (!notes.length) return { status: "success", notes: [], message: "No therapeutic notes found." };
		return { status: "success", notes };
	}
};
