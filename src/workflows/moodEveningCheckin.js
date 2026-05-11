import { WorkflowEntrypoint } from 'cloudflare:workers';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';

/**
 * Mood Evening Check-in Workflow (trial, /mood only)
 *
 * Durable, event-driven replacement for the KV state machine in moodFlow.js.
 * The cron-triggered evening check-in still uses the existing path; this
 * workflow is gated behind env.USE_MOOD_WORKFLOW and only fires from /mood.
 *
 * Flow:
 *   1. send-score-poll              -> waitForEvent('score_received')
 *   2. send-score-response          (AI message + emotion category buttons)
 *   3.                              waitForEvent('emotions_done')
 *   4. emotions-ack                 (Workers AI micro-ack)
 *   5. send-activities-keyboard     -> waitForEvent('activities_done')
 *   6. send-photo-prompt            -> waitForEvent('photo_done')
 *   7. send-sleep-keyboard          -> waitForEvent('sleep_logged')
 *   8. fire-synthesis               (the 6-tier cascade)
 *
 * Coexistence with existing flow during trial:
 *   - This workflow runs alongside the KV state machine (moodFlow.js).
 *   - The KV state machine is left untouched so the AI's commit_journal_entry
 *     tool and the existing safety net keep working.
 *   - Each step writes to D1 the same way the existing callbacks do, so the
 *     data path is identical.
 *
 * Webhook contract:
 *   The Worker fetch handler looks up this workflow by instance id
 *   `mood_eve_${chatId}_${today}` and calls .sendEvent() after each
 *   user-side action lands in D1. Events:
 *     - score_received    payload: { score }
 *     - emotions_done     payload: { emotions: string[] }
 *     - activities_done   payload: { added: string[], removed: string[] }
 *     - photo_done        payload: { skipped: boolean, photo_r2_key?: string }
 *     - sleep_logged      payload: { sleep_hours: number, skipped: boolean }
 *
 * Each waitForEvent has a 4h timeout — long enough that a user can step
 * away for hours and still resume, short enough that yesterday's stalled
 * workflow doesn't hang around forever.
 */
export class MoodEveningCheckinWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const { chatId, userId, threadId, today } = event.payload;
		if (!chatId || !userId || !today) {
			throw new Error('Missing chatId/userId/today in workflow payload');
		}

		const env = this.env;

		// ----- 1. Send the score poll -----
		await step.do('send-score-poll', {
			retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
			timeout: '15 seconds',
		}, async () => {
			const payload = {
				chat_id: chatId,
				question: 'How do you feel right now?',
				options: MOOD_POLL_OPTIONS.map(t => ({ text: t })),
				is_anonymous: false,
				allows_multiple_answers: false,
			};
			if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPoll`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!json.ok) throw new Error(`sendPoll failed: ${json.description || 'unknown'}`);

			// Map poll_id -> chat so the poll_answer webhook can route back to us.
			// Reuses the existing key format so the existing handler picks it up.
			const pollId = json.result.poll.id;
			await env.CHAT_KV.put(`mood_poll_${pollId}`, JSON.stringify({
				chatId, threadId, type: 'mood_checkin', sentAt: Date.now(),
				source: 'manual_command', workflowId: event.instanceId,
			}), { expirationTtl: 86400 });

			return { pollId };
		});

		// ----- 2. Wait for the score -----
		// handleMoodPollAnswer (in index.js) handles the D1 write, AI message,
		// emotion category buttons. It sends 'score_received' to us after that
		// work lands. Workflow does not duplicate the AI message — the existing
		// path stays load-bearing for the score-response UX.
		const scoreEvent = await step.waitForEvent('await-score', {
			type: 'score_received',
			timeout: '4 hours',
		});
		const score = scoreEvent?.payload?.score;

		// ----- 3. Wait for emotions -----
		// Extreme scores (0-1, 9-10) skip the emotion buttons entirely. In that
		// case the existing callback handler skips emotion collection and the
		// AI conversation proceeds in prose. Workflow still waits for the event
		// because someone has to push it forward — we accept either real
		// emotions or an empty list as "emotions done".
		const emotionsEvent = await step.waitForEvent('await-emotions', {
			type: 'emotions_done',
			timeout: '4 hours',
		});
		const emotions = emotionsEvent?.payload?.emotions || [];

		// ----- 4. Emotions micro-ack -----
		// handleMoodPollAnswer (index.js) already fires its own score-ack via
		// runScoreAck — that lands BEFORE the user picks emotions. The existing
		// mood_emo_done callback ALSO sends an emotions-ack via runEmotionsAck.
		// To avoid double-ack we skip the workflow-side emotions ack and rely
		// on the existing callback handler. Left as a marked no-op so the step
		// numbering matches the original plan in case we move it later.

		// ----- 6. Send activities keyboard -----
		await step.do('send-activities-keyboard', {
			retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
			timeout: '15 seconds',
		}, async () => {
			const { buildActivitiesKeyboard } = await import('../tools/moodKeyboards');
			const moodStore = await import('../services/moodStore');
			const alreadyLogged = await moodStore.getTodayActivities(env, userId, today).catch(() => []);
			const keyboard = buildActivitiesKeyboard('new', alreadyLogged, [], []);

			const payload = {
				chat_id: chatId,
				text: 'What activities did you do today? Tap to add.',
				reply_markup: keyboard,
			};
			if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
			const msgId = json.result?.message_id;

			// Reuse the existing KV pending-state structure so the existing
			// activities callback handler can keep rendering/committing. This
			// is the bridge between the workflow and the existing handler.
			const moodFlow = await import('../lib/moodFlow');
			await moodFlow.initActivitiesPending(env, chatId, msgId).catch(() => {});
			return { msgId };
		});

		// ----- 7. Wait for activities done -----
		await step.waitForEvent('await-activities', {
			type: 'activities_done',
			timeout: '4 hours',
		});

		// ----- 8. Send photo prompt -----
		const photoStepResult = await step.do('send-photo-prompt', {
			retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
			timeout: '15 seconds',
		}, async () => {
			const moodStore = await import('../services/moodStore');
			// If a photo has already landed today, skip straight past.
			const hasPhoto = await moodStore.hasPhotoLoggedToday(env, userId).catch(() => false);
			if (hasPhoto) return { skipped: true, reason: 'photo_already_today' };

			const payload = {
				chat_id: chatId,
				text: 'Got a photo from today? Send it whenever, or tap Skip.',
				reply_markup: { inline_keyboard: [[{ text: 'Skip photo', callback_data: 'mood_photo|skip' }]] },
			};
			if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
			const msgId = json.result?.message_id;

			const moodFlow = await import('../lib/moodFlow');
			await moodFlow.initPhotoPending(env, chatId, msgId).catch(() => {});
			return { msgId };
		});

		// ----- 9. Wait for photo or skip -----
		// Only wait if the photo prompt actually rendered. If we skipped because
		// a photo was already logged today, there is no UI for the user to act
		// on, so waiting would stall the workflow for 4 hours.
		if (!photoStepResult?.skipped) {
			await step.waitForEvent('await-photo', {
				type: 'photo_done',
				timeout: '4 hours',
			});
		}

		// ----- 10. Send sleep keyboard -----
		// Deterministic. 4h..12h+ + Skip. If sleep is already logged today,
		// skip the prompt and treat as already-done.
		const sleepStepResult = await step.do('send-sleep-keyboard', {
			retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
			timeout: '15 seconds',
		}, async () => {
			const moodStore = await import('../services/moodStore');
			const hasSleep = await moodStore.hasSleepLoggedToday(env, userId, today).catch(() => false);
			if (hasSleep) return { skipped: true, reason: 'sleep_already_today' };

			const keyboard = {
				inline_keyboard: [
					[
						{ text: '4h', callback_data: 'mood_sleep|4' },
						{ text: '5h', callback_data: 'mood_sleep|5' },
						{ text: '6h', callback_data: 'mood_sleep|6' },
					],
					[
						{ text: '7h', callback_data: 'mood_sleep|7' },
						{ text: '8h', callback_data: 'mood_sleep|8' },
						{ text: '9h', callback_data: 'mood_sleep|9' },
					],
					[
						{ text: '10h', callback_data: 'mood_sleep|10' },
						{ text: '11h', callback_data: 'mood_sleep|11' },
						{ text: '12h+', callback_data: 'mood_sleep|12' },
					],
					[
						{ text: 'Skip', callback_data: 'mood_sleep|skip' },
					],
				],
			};

			const payload = {
				chat_id: chatId,
				text: 'How did you sleep last night?',
				reply_markup: keyboard,
			};
			if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
			return { msgId: json.result?.message_id };
		});

		// ----- 11. Wait for sleep -----
		// Same shortcut as photo: skip the wait if the keyboard wasn't rendered.
		if (!sleepStepResult?.skipped) {
			await step.waitForEvent('await-sleep', {
				type: 'sleep_logged',
				timeout: '4 hours',
			});
		}

		// ----- 12. Fire synthesis -----
		// Runs the 6-tier cascade inline (not via the queue) so we can persist
		// the result as a workflow step output. If synthesis succeeds, the
		// text is sent to Telegram from inside this step. The KV synthesis
		// guard is still set to prevent the queue path from firing again.
		const synthResult = await step.do('fire-synthesis', {
			retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
			timeout: '120 seconds',
		}, async () => {
			const guardKey = `mood_synthesis_fired_${chatId}_${today}`;
			// Set the guard FIRST. If the existing queue path also fires while
			// we are computing, this prevents a double-send. Idempotent.
			await env.CHAT_KV.put(guardKey, '1', { expirationTtl: 26 * 3600 });

			const { runSynthesisCascade } = await import('../services/moodSynthesis');
			const { personas } = await import('../config/personas');

			const synth = await runSynthesisCascade(env, userId, event.timestamp?.getTime() || Date.now(), personas.xaridotis.instruction);

			if (synth?.text) {
				// Typing indicator before the synthesis message, matching the
				// existing UX in index.js queue consumer.
				try {
					const tPayload = { chat_id: chatId, action: 'typing' };
					if (threadId && threadId !== 'default') tPayload.message_thread_id = Number(threadId);
					await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendChatAction`, {
						method: 'POST', headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(tPayload),
					});
				} catch { /* non-fatal */ }

				const payload = { chat_id: chatId, text: synth.text, parse_mode: 'HTML' };
				if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);
				await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
			}

			// End the KV-side flow tracker too, since the check-in is fully
			// complete now.
			const moodFlow = await import('../lib/moodFlow');
			await moodFlow.endFlow(env, chatId).catch(() => {});
			await env.CHAT_KV.delete(`health_checkin_active_${chatId}`).catch(() => {});

			return { source: synth.source, ms: synth.ms, textLen: synth.text?.length || 0 };
		});

		return {
			status: 'completed',
			score,
			emotionCount: emotions.length,
			synthesisSource: synthResult.source,
			synthesisMs: synthResult.ms,
		};
	}
}
