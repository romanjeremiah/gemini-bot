/**
 * Mood Journal Gemini Tools
 * log_mood_entry: Save/update mood data (partial upserts supported)
 * get_mood_history: Retrieve past entries for analysis
 */

import * as moodStore from '../services/moodStore';
import * as mediaStore from '../services/mediaStore';
import { ACTIVITY_LABELS_CSV, canonicaliseActivities } from '../config/activities';

export const logMoodEntryTool = {
	definition: {
		name: "log_mood_entry",
		description: `Log a mood journal entry or update today's existing entry. Use this when:
- The user explicitly reports their mood, sleep, medication, or activities
- You detect mood-relevant information naturally in conversation (e.g. "I slept terribly" or "feeling great today")
- During a scheduled health check-in
- The user says something indicating a mood state on the bipolar scale

Partial updates are supported. You can log just sleep in the morning and add mood score in the evening.
The system uses a bipolar mood scale (0-10):
0-1: Severe Depression, 2-3: Mild/Moderate Depression, 4-6: Balanced, 7-8: Hypomania, 9-10: Mania.

IMPORTANT: If mood_score is 0-1 or 9-10, this is a clinical concern. Always acknowledge it compassionately and suggest professional contact.

IMPORTANT for ACTIVITIES: only use these canonical values: ${ACTIVITY_LABELS_CSV}. Do not invent activity names. If you want to collect activities during a check-in, prefer calling send_activities_keyboard instead of asking in prose — the keyboard handles add/remove cleanly. Only call log_mood_entry with an activities array if the user mentions specific activities directly in chat.

IMPORTANT for SOURCE: do NOT pass a 'source' parameter — the runtime sets it automatically based on context (cron poll, /mood command, or inline chat).`,
		parameters: {
			type: "OBJECT",
			properties: {
				entry_type: {
					type: "STRING",
					enum: ["morning", "midday", "evening"],
					description: "Which check-in this data belongs to. Default 'evening' for ad-hoc logging."
				},
				mood_score: {
					type: "INTEGER",
					description: "Bipolar mood scale 0-10. 0=severe depression, 5=balanced, 10=mania."
				},
				emotions: {
					type: "ARRAY",
					items: { type: "STRING" },
					description: "List of identified emotions. Positive: happy, calm, motivated, grateful, confident, energetic, inspired, relaxed, brave, joyful. Negative: anxious, sad, lonely, frustrated, tired, paranoid, confused, angry, scared, empty."
				},
				sleep_hours: {
					type: "NUMBER",
					description: "Hours of sleep (e.g. 7.5)"
				},
				sleep_quality: {
					type: "STRING",
					enum: ["poor", "fair", "good", "excellent"],
					description: "Subjective sleep quality"
				},
				medication_taken: {
					type: "BOOLEAN",
					description: "Whether medication was taken"
				},
				medication_notes: {
					type: "STRING",
					description: "Which medications, timing, on-time or late. ALL times in 24-hour format. E.g. 'Bipolar meds on time at 08:15, ADHD meds 30min late at 09:45'. NEVER use '8 AM' or '9:45 AM'."
				},
				activities: {
					type: "ARRAY",
					items: { type: "STRING" },
					description: "List of activities done today. E.g. ['gym', 'coding', 'therapy', 'walking']"
				},
				note: {
					type: "STRING",
					description: "Free-text journal note or observation for the day. Write in SECOND PERSON as if the user is journaling to themselves: 'You hit the gym before the 09:00 meeting, felt sharp all morning'. NEVER use third person ('Roman hit the gym...'). ALL times in 24-hour format."
				},
				ai_observation: {
					type: "STRING",
					description: "Your clinical observation about the user's state today. Write in SECOND PERSON from your perspective to them: 'You are running consistent sleep at 7h but your 22:00 energy spike matches a hypomanic pattern from March'. NEVER narrate in third person. ALL times in 24-hour format. Be specific, reference patterns."
				},
				link_latest_photo: {
					type: "BOOLEAN",
					description: "Set to true if the user just uploaded an image to capture the atmosphere of the day. This links their most recent photo to the journal entry."
				}
			},
			required: ["entry_type"]
		}
	},
	async execute(args, env, context) {
		const date = moodStore.todayLondon();

		// Auto-link the latest uploaded photo if requested
		let photoKey = null;
		if (args.link_latest_photo && env.MEDIA_BUCKET) {
			const recent = await mediaStore.listMedia(env, context.userId, 'image', 1);
			if (recent?.length) photoKey = recent[0].key;
		}

		// Canonicalise any activities the AI passed inline. Filters out non-canonical
		// values silently — the keyboard is the preferred path for activities.
		const canonActivities = args.activities ? canonicaliseActivities(args.activities) : null;

		// Source resolution: callers (cron, /mood handler, queue consumer) pass an
		// explicit source via context.source. AI tool calls don't, so default to
		// 'inline_chat'. Never let the AI override this — we ignore args.source.
		const source = context?.source || 'inline_chat';

		const data = {
			mood_score: args.mood_score ?? null,
			emotions: args.emotions ? JSON.stringify(args.emotions) : null,
			sleep_hours: args.sleep_hours ?? null,
			sleep_quality: args.sleep_quality || null,
			medication_taken: args.medication_taken ? 1 : 0,
			medication_time: null,
			medication_notes: args.medication_notes || null,
			activities: canonActivities ? JSON.stringify(canonActivities) : null,
			note: args.note || null,
			ai_observation: args.ai_observation || null,
			photo_r2_key: photoKey,
			source,
		};
		const entry = await moodStore.upsertEntry(env, context.userId, date, args.entry_type || 'evening', data);
		console.log(`📊 Mood logged: ${date} ${args.entry_type} score=${args.mood_score} src=${source}`);

		// Dynamic feedback: tell the AI what's still missing.
		// Updated 2026-05-05: when the deterministic flow is active (mood_flow_*
		// KV key set), the keyboard tools handle activities/sleep/photo — don't
		// nudge the AI to ask for them in prose.
		const missing = [];
		if (entry.sleep_hours === null) missing.push('sleep hours/quality');
		if (!entry.emotions || entry.emotions === '[]' || entry.emotions === 'null') missing.push('specific emotions');
		if (!entry.activities || entry.activities === '[]' || entry.activities === 'null') missing.push('activities');
		if (!entry.photo_r2_key) missing.push('a photo of the day');
		if (!entry.note) missing.push('final reflections');

		const flowActive = await env.CHAT_KV.get(`mood_flow_${context.chatId || context.userId}`);
		const next_step = flowActive
			? 'Data logged. The deterministic check-in flow is active — it will collect activities, sleep, and photo via keyboards. Respond warmly to what was just logged but DO NOT ask about other missing pieces in prose.'
			: (missing.length > 0
				? `Data logged. Still missing: ${missing.join(', ')}. Ask ONE natural question to gather the next piece, OR call send_activities_keyboard / send_photo_request if you're inside an evening check-in.`
				: 'Journal complete for today. Warmly summarise the day and wrap up the check-in.');

		return { status: "success", date, entry_type: args.entry_type, mood_score: args.mood_score, mood_label: entry.mood_label, next_step };
	}
};

export const getMoodHistoryTool = {
	definition: {
		name: "get_mood_history",
		description: `Retrieve mood journal history for analysis. Use this when:
- The user asks about their mood trends, patterns, or history
- You need to analyse mood vs sleep, medication adherence, or activity correlations
- Before an evening check-in, to summarise the day
- When the user asks "how have I been doing?"

Returns structured data you can analyse. For deeper statistical analysis, combine with code_execution to compute correlations.
When presenting analysis, cite relevant clinical frameworks:
- Bipolar: NICE CG185/NG193, BAP guidelines
- ADHD: NICE NG87
- General: WHO, APA practice guidelines`,
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "INTEGER",
					description: "Number of days of history to retrieve. Default 14."
				},
				entry_type: {
					type: "STRING",
					enum: ["morning", "midday", "evening"],
					description: "Filter by check-in type. Omit for all types."
				}
			},
			required: []
		}
	},
	async execute(args, env, context) {
		const entries = await moodStore.getHistory(env, context.userId, args.days || 14, args.entry_type || null);
		if (!entries.length) return { status: "success", entries: [], message: "No mood data recorded yet." };
		// Parse JSON fields for the AI
		const parsed = entries.map(e => ({
			...e,
			emotions: safeParseJSON(e.emotions),
			activities: safeParseJSON(e.activities),
		}));
		return { status: "success", count: parsed.length, entries: parsed };
	}
};

function safeParseJSON(str) {
	if (!str) return null;
	try { return JSON.parse(str); } catch { return str; }
}
