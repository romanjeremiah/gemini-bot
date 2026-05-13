// Evening mood check-in flow tracker.
//
// LAYER 3 STATUS (2026-05-13): demoted to write-through cache.
//
// The Cloudflare Workflow (src/workflows/moodEveningCheckin.js) is now the
// single source of truth for the evening flow. This module is kept ONLY so
// the AI-driven tools (send_activities_keyboard, send_photo_request,
// commit_journal_entry) still have a place to record progress markers that
// the persona prompt can read. The cron-driven KV safety-net that used this
// state has been removed. Do not add new safety-net logic here — add steps
// to the workflow instead.
//
// State key: `mood_flow_${chatId}`
// TTL: 1800s (30 min) — refreshed on every progress update
//
// Shape:
//   {
//     started_at: number,            // Unix ms when flow began
//     last_progress_at: number,      // Unix ms of last meaningful tick
//     source: 'cron_poll' | 'manual_command',
//     stage: 'score' | 'emotions' | 'activities' | 'sleep' | 'photo' | 'wrap',
//     activities: {                  // Pending state for the activities keyboard
//       msg_id: number,              // Telegram message id of the live keyboard
//       mode: 'new' | 'completed',
//       pending_new: string[],       // Activity keys queued to add on Done
//       pending_remove: string[],    // Activity keys queued to remove on Done
//     } | null,
//     photo: {                       // Pending state for the photo step
//       msg_id: number,              // Telegram message id of the prompt
//       skipped: boolean,
//     } | null,
//   }

import * as moodStore from '../services/moodStore';

const FLOW_TTL_SECONDS = 1800;
const STALL_THRESHOLD_MS = 20 * 60 * 1000; // 20 min — safety net trigger

const flowKey = (chatId) => `mood_flow_${chatId}`;

export async function getFlow(env, chatId) {
	return await env.CHAT_KV.get(flowKey(chatId), { type: 'json' });
}

export async function setFlow(env, chatId, flow) {
	flow.last_progress_at = Date.now();
	await env.CHAT_KV.put(flowKey(chatId), JSON.stringify(flow), { expirationTtl: FLOW_TTL_SECONDS });
	return flow;
}

export async function startFlow(env, chatId, source = 'cron_poll') {
	const now = Date.now();
	const flow = {
		started_at: now,
		last_progress_at: now,
		source,
		stage: 'score',
		activities: null,
		photo: null,
	};
	await env.CHAT_KV.put(flowKey(chatId), JSON.stringify(flow), { expirationTtl: FLOW_TTL_SECONDS });
	return flow;
}

export async function endFlow(env, chatId) {
	await env.CHAT_KV.delete(flowKey(chatId));
}

export async function setStage(env, chatId, stage) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;
	flow.stage = stage;
	return await setFlow(env, chatId, flow);
}

/**
 * Advance the flow stage to whatever piece of data is missing next.
 *
 * Stage tracking philosophy (decided 2026-05-06): the stage value always
 * represents "what's the next missing piece", never a "_done" marker for
 * what just finished. The moment a piece lands, we re-derive the stage
 * from D1 + flow state. This keeps the safety net's stage→keyboard mapping
 * trivial: each stage corresponds to exactly one keyboard or prose ask.
 *
 * Canonical order (mirrors getCheckinRoadmap pieces order, plus emotions
 * which is collected upstream by the emotion buttons):
 *   emotions → activities → photo → sleep → wrap
 *
 * Idempotent. Safe to call after every meaningful event in the flow.
 * Call sites:
 *   - handleMoodPollAnswer (after score upsert)            → score lands, advance to emotions
 *   - mood_emo_done callback (after emotions upsert)       → emotions land, advance to next missing
 *   - mood_act|done handler (after mergeActivities)        → activities land, advance to next missing
 *   - photo upload handler (after photo_r2_key written)    → photo lands, advance to next missing
 *   - handlePhotoSkipCallback (after markPhotoSkipped)     → photo skipped, advance to next missing
 *   - logMoodEntryTool.execute (after upsertEntry)         → AI-driven log (sleep, etc) advances
 *
 * Returns the updated flow, or null if no flow is active.
 */
export async function advanceStage(env, chatId, userId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;

	const today = moodStore.todayLondon();
	const entry = await moodStore.getEntry(env, userId, today, 'evening').catch(() => null);

	const hasEmotions = !!(entry?.emotions && entry.emotions !== '[]' && entry.emotions !== 'null');
	const hasActivities = !!(entry?.activities && entry.activities !== '[]' && entry.activities !== 'null');
	const hasPhoto = !!entry?.photo_r2_key || flow.photo?.skipped === true;
	const hasSleep = entry?.sleep_hours !== null && entry?.sleep_hours !== undefined;

	let nextStage;
	if (!hasEmotions) nextStage = 'emotions';
	else if (!hasActivities) nextStage = 'activities';
	else if (!hasPhoto) nextStage = 'photo';
	else if (!hasSleep) nextStage = 'sleep';
	else nextStage = 'wrap';

	flow.stage = nextStage;
	return await setFlow(env, chatId, flow);
}

/**
 * Detect a stalled flow. Returns true if a flow is active AND the last
 * progress event was longer ago than STALL_THRESHOLD_MS.
 */
export async function isStalled(env, chatId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return false;
	return (Date.now() - (flow.last_progress_at || flow.started_at)) > STALL_THRESHOLD_MS;
}

// ----- Activities keyboard pending-state helpers -----

export async function initActivitiesPending(env, chatId, msgId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;
	flow.activities = {
		msg_id: msgId,
		mode: 'new',
		pending_new: [],
		pending_remove: [],
	};
	flow.stage = 'activities';
	return await setFlow(env, chatId, flow);
}

export async function toggleActivityPending(env, chatId, activityKey) {
	const flow = await getFlow(env, chatId);
	if (!flow?.activities) return null;
	const a = flow.activities;
	const list = a.mode === 'new' ? a.pending_new : a.pending_remove;
	const idx = list.indexOf(activityKey);
	if (idx >= 0) list.splice(idx, 1);
	else list.push(activityKey);
	return await setFlow(env, chatId, flow);
}

export async function setActivitiesMode(env, chatId, mode) {
	const flow = await getFlow(env, chatId);
	if (!flow?.activities) return null;
	flow.activities.mode = mode;
	return await setFlow(env, chatId, flow);
}

export async function clearActivitiesPending(env, chatId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;
	flow.activities = null;
	return await setFlow(env, chatId, flow);
}

// ----- Photo step helpers -----

export async function initPhotoPending(env, chatId, msgId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;
	flow.photo = { msg_id: msgId, skipped: false };
	flow.stage = 'photo';
	return await setFlow(env, chatId, flow);
}

export async function markPhotoSkipped(env, chatId) {
	const flow = await getFlow(env, chatId);
	if (!flow) return null;
	if (flow.photo) flow.photo.skipped = true;
	return await setFlow(env, chatId, flow);
}

/**
 * Is the chat currently in the photo-collection stage? Used by the photo
 * upload handler in handlers.js to decide whether to auto-link the upload
 * to today's mood entry.
 */
export async function isAwaitingPhoto(env, chatId) {
	const flow = await getFlow(env, chatId);
	return flow?.stage === 'photo' && !flow?.photo?.skipped;
}

export { FLOW_TTL_SECONDS, STALL_THRESHOLD_MS };

/**
 * Map a flow's start time to a dynamic period label like "this morning",
 * "this afternoon", "this evening", or "tonight".
 *
 * Used by mood prompts (micro-acks and synthesis) so the model has timing
 * context without hardcoded "evening" / "tonight" assumptions. The check-in
 * can be triggered by the morning cron, midday cron, evening cron, or the
 * manual /mood command at any time of day — the period label adapts.
 *
 * Computed in Europe/London. Returns one of:
 *   "this morning"   (00:00 - 11:59 London)
 *   "this afternoon" (12:00 - 16:59 London)
 *   "this evening"   (17:00 - 21:59 London)
 *   "tonight"        (22:00 - 23:59 London)
 *
 * @param {number} startedAtMs - Unix ms timestamp of when the flow started
 * @returns {string} Period label, e.g. "this evening"
 */
export function getCheckinTiming(startedAtMs) {
	const d = new Date(startedAtMs || Date.now());
	const hourStr = d.toLocaleString('en-GB', {
		timeZone: 'Europe/London',
		hour: '2-digit',
		hour12: false,
	});
	const hour = parseInt(hourStr, 10);
	if (hour < 12) return 'this morning';
	if (hour < 17) return 'this afternoon';
	if (hour < 22) return 'this evening';
	return 'tonight';
}
