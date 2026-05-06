// Tools for the deterministic mood-flow keyboards.
//
// These tools are how the AI invokes structured collection (activities, photo)
// and signals completion (commit_journal_entry) inside an evening check-in.
// The AI still drives the flow conversationally; these tools render the
// structured UI and act as the gate that ensures critical pieces are captured.
//
// All three tools require an active mood_flow_${chatId} state. If no flow is
// active, they noop with an explanatory next_step so the AI doesn't hallucinate
// a structured step outside an actual check-in.

import * as moodStore from '../services/moodStore';
import * as moodFlow from '../lib/moodFlow';
import * as telegram from '../lib/telegram';
import { TOPIC_KEYS, threadOrDefault } from '../lib/topics';
import { ACTIVITIES, ACTIVITY_BY_KEY } from '../config/activities';
import { log } from '../lib/logger';

// ----- Activities keyboard renderer (shared with handlers.js callbacks) -----

/**
 * Build the inline keyboard for the activities multi-select. Mode determines
 * which list of activities is shown:
 *   - 'new':       canonical list MINUS already-logged activities for today,
 *                  with ✓ prefix on those queued in pending_new
 *   - 'completed': already-logged activities for today, with ✗ prefix on
 *                  those queued in pending_remove
 *
 * Last row is always [Next: <other mode>] [✓ Done].
 */
export function buildActivitiesKeyboard(mode, alreadyLogged, pendingNew, pendingRemove) {
	const rows = [];
	let visibleCount = 0;

	if (mode === 'new') {
		// Show canonical activities not already logged today.
		const visible = ACTIVITIES
			.map((a, idx) => ({ ...a, idx }))
			.filter(a => !alreadyLogged.includes(a.key));
		visibleCount = visible.length;

		if (visibleCount === 0) {
			rows.push([{ text: 'All 26 activities logged today 💪', callback_data: 'mood_act|noop' }]);
		} else {
			// 4 cols per row
			for (let i = 0; i < visible.length; i += 4) {
				const row = visible.slice(i, i + 4).map(a => ({
					text: pendingNew.includes(a.key) ? `✓ ${a.label}` : a.label,
					callback_data: `mood_act|${a.idx}`,
				}));
				rows.push(row);
			}
		}
	} else {
		// 'completed' mode: show already-logged activities so user can remove.
		const visible = alreadyLogged
			.map(key => ({ key, ...ACTIVITY_BY_KEY[key] }))
			.filter(a => a && a.label);
		visibleCount = visible.length;

		if (visibleCount === 0) {
			rows.push([{ text: 'Nothing logged yet today', callback_data: 'mood_act|noop' }]);
		} else {
			for (let i = 0; i < visible.length; i += 4) {
				const row = visible.slice(i, i + 4).map(a => ({
					text: pendingRemove.includes(a.key) ? `✗ ${a.label}` : a.label,
					callback_data: `mood_act|${a.idx}`,
				}));
				rows.push(row);
			}
		}
	}

	// Mode toggle + Done row
	const otherMode = mode === 'new' ? 'completed' : 'new';
	const otherLabel = mode === 'new' ? '⏭ Next: Completed' : '⏭ Next: New';
	rows.push([
		{ text: otherLabel, callback_data: `mood_act|mode|${otherMode}` },
		{ text: '✓ Done', callback_data: 'mood_act|done' },
	]);

	return { inline_keyboard: rows };
}

export const sendActivitiesKeyboardTool = {
	definition: {
		name: 'send_activities_keyboard',
		description: `Send an inline keyboard so the user can multi-select today's activities. Use this DURING an evening check-in (after mood score and emotions have been collected) instead of asking about activities in prose.

The keyboard has two modes the user can flip between:
- New mode (default): shows activities not yet logged today; tapping selects them to add
- Completed mode: shows activities already logged today; tapping selects them to remove

A single ✓ Done button commits both adds and removes at once. The user sees a summary like "Added: gym, reading. Removed: work."

Only call this once per check-in. After Done is pressed, control returns to you with the result. If you call this and an evening check-in is not active, it returns an error with next_step.`,
		parameters: {
			type: 'OBJECT',
			properties: {
				preamble: {
					type: 'STRING',
					description: "Short, warm 1-sentence message shown above the keyboard. E.g. 'What did you get up to today?' or 'Anything new from this morning?'. Match the tone of the conversation. If empty, a default is used.",
				},
			},
			required: [],
		},
	},
	async execute(args, env, context) {
		const chatId = context.chatId || context.userId;
		const flow = await moodFlow.getFlow(env, chatId);
		if (!flow) {
			return {
				status: 'error',
				message: 'No active mood-check-in flow.',
				next_step: 'You can only send the activities keyboard during an active evening check-in. Respond conversationally instead.',
			};
		}

		const userId = context.userId;
		const today = moodStore.todayLondon();
		const alreadyLogged = await moodStore.getTodayActivities(env, userId, today);

		const preamble = (args.preamble || 'What activities did you do today? Tap to add.').slice(0, 300);
		const threadId = await threadOrDefault(env, chatId, TOPIC_KEYS.MOOD_JOURNAL);

		const keyboard = buildActivitiesKeyboard('new', alreadyLogged, [], []);
		const res = await telegram.sendMessage(chatId, threadId, preamble, env, null, keyboard);
		const msgId = res?.result?.message_id;
		if (msgId) {
			await moodFlow.initActivitiesPending(env, chatId, msgId);
		}
		log.info('activities_keyboard_sent', { chatId, alreadyLogged: alreadyLogged.length, msgId });

		return {
			status: 'success',
			next_step: 'The activities keyboard is now showing. WAIT for the user to press Done — do not respond further until then. The keyboard handles add/remove cleanly. After Done, you will receive a summary and can move on to ask about sleep (only if not already logged today) or photo (only if not already attached today).',
		};
	},
};

export const sendPhotoRequestTool = {
	definition: {
		name: 'send_photo_request',
		description: `Ask the user for a photo of the day during an evening check-in. Sends a brief prompt with a [Skip photo] inline button.

Use this near the end of an evening check-in, AFTER activities and sleep have been handled, IF no photo has been attached to today's mood entry yet. Calling this when a photo is already attached will noop.

The user can either send any photo within 30 minutes (auto-linked to today's evening entry) or tap Skip. After either action, control returns to you to wrap up the journal.`,
		parameters: {
			type: 'OBJECT',
			properties: {
				preamble: {
					type: 'STRING',
					description: "Short 1-sentence prompt shown above the Skip button. E.g. 'Got a photo from today?'. If empty, a default is used.",
				},
			},
			required: [],
		},
	},
	async execute(args, env, context) {
		const chatId = context.chatId || context.userId;
		const flow = await moodFlow.getFlow(env, chatId);
		if (!flow) {
			return {
				status: 'error',
				message: 'No active mood-check-in flow.',
				next_step: 'You can only request a photo during an active evening check-in.',
			};
		}

		const userId = context.userId;
		if (await moodStore.hasPhotoLoggedToday(env, userId)) {
			return {
				status: 'noop',
				next_step: 'A photo is already attached to today. Skip the photo step and move to the wrap-up.',
			};
		}

		const preamble = (args.preamble || 'Got a photo from today? Send it whenever, or tap Skip.').slice(0, 300);
		const threadId = await threadOrDefault(env, chatId, TOPIC_KEYS.MOOD_JOURNAL);
		const keyboard = {
			inline_keyboard: [[{ text: 'Skip photo', callback_data: 'mood_photo|skip' }]],
		};

		const res = await telegram.sendMessage(chatId, threadId, preamble, env, null, keyboard);
		const msgId = res?.result?.message_id;
		if (msgId) {
			await moodFlow.initPhotoPending(env, chatId, msgId);
		}
		log.info('photo_request_sent', { chatId, msgId });

		return {
			status: 'success',
			next_step: 'Photo prompt is now showing. WAIT for the user to either upload a photo or tap Skip. Do not respond further until one of those happens.',
		};
	},
};

export const commitJournalEntryTool = {
	definition: {
		name: 'commit_journal_entry',
		description: `Signal that you consider today's evening journal complete. Use this ONLY at the end of an evening check-in, after you have:
1. Captured a mood score (collected via the poll)
2. Captured emotions (collected via the inline buttons)
3. Either: collected activities via send_activities_keyboard, OR confirmed activities are already logged today
4. Either: collected sleep_hours (if not already logged today), OR confirmed sleep is already logged
5. Either: called send_photo_request (if no photo today), OR confirmed a photo is already attached

If any of those critical pieces are missing, this tool will REFUSE to commit and return an instruction telling you what to address. It acts as the safety gate.

After successful commit, the active flow is cleared. You should send a warm wrap-up message after this returns success.`,
		parameters: {
			type: 'OBJECT',
			properties: {
				wrap_up: {
					type: 'STRING',
					description: 'Optional brief observation about the day to save as ai_observation on the entry. Second-person prose. Keep under 300 chars.',
				},
			},
			required: [],
		},
	},
	async execute(args, env, context) {
		const chatId = context.chatId || context.userId;
		const userId = context.userId;
		const flow = await moodFlow.getFlow(env, chatId);
		if (!flow) {
			return {
				status: 'error',
				message: 'No active flow to commit.',
				next_step: 'There is no active evening check-in to commit. Just respond normally.',
			};
		}

		const today = moodStore.todayLondon();
		const entry = await moodStore.getEntry(env, userId, today, 'evening');

		// Gate: refuse to commit if critical pieces are missing.
		const missing = [];
		if (!entry?.mood_score && entry?.mood_score !== 0) missing.push('mood_score (the poll has not been answered)');
		if (!entry?.emotions || entry.emotions === '[]') missing.push('emotions (no emotion buttons selected yet)');
		if (!entry?.activities || entry.activities === '[]') {
			// Activities are only required if the user hasn't logged any across today.
			const todayActs = await moodStore.getTodayActivities(env, userId, today);
			if (todayActs.length === 0) missing.push('activities (call send_activities_keyboard)');
		}
		const sleepLogged = await moodStore.hasSleepLoggedToday(env, userId, today);
		if (sleepLogged === null || sleepLogged === undefined) missing.push('sleep_hours (ask the user how they slept and log via log_mood_entry)');
		const photoLogged = await moodStore.hasPhotoLoggedToday(env, userId, today);
		const photoSkipped = flow.photo?.skipped === true;
		if (!photoLogged && !photoSkipped) missing.push('photo (call send_photo_request)');

		if (missing.length > 0) {
			log.info('commit_blocked', { chatId, missing });
			return {
				status: 'blocked',
				missing,
				next_step: `Cannot commit yet. Still missing: ${missing.join('; ')}. Address the FIRST missing item now.`,
			};
		}

		// All clear — write the wrap-up note if provided, end flow.
		if (args.wrap_up) {
			await moodStore.upsertEntry(env, userId, today, 'evening', {
				ai_observation: String(args.wrap_up).slice(0, 1000),
				source: flow.source || 'cron_poll',
			});
		}
		await moodFlow.endFlow(env, chatId);
		await env.CHAT_KV.delete(`health_checkin_active_${chatId}`);
		log.info('journal_committed', { chatId, source: flow.source });

		return {
			status: 'success',
			next_step: 'Journal committed for today. Send a brief warm wrap-up message to the user (1-2 sentences max).',
		};
	},
};
