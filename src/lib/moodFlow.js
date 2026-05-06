// Evening mood check-in flow tracker.
//
// Lives alongside the AI-driven journal flow as a *progress tracker*, not a
// hard state machine. The AI still drives stage transitions by calling tools
// (send_activities_keyboard, send_photo_request, commit_journal_entry). This
// module records what's been done so the safety-net cron can take over if
// the AI stalls.
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
