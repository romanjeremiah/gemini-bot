import { WorkflowEntrypoint } from 'cloudflare:workers';
import { MOOD_POLL_OPTIONS } from '../config/moodScale';

/**
 * Mood Evening Check-in Workflow — single source of truth (Layer 3, 2026-05-13).
 *
 * Replaces the legacy KV+queue+safety-net path. ALL evening check-ins
 * (both cron and /mood) route through this workflow. The KV moodFlow.js
 * is kept as a thin write-through cache so AI tools (commit_journal_entry,
 * isAwaitingPhoto) keep working, but it no longer drives the flow.
 *
 * Design principles:
 *   - Workflow steps own all side effects. Webhook callbacks dispatch events
 *     and otherwise stay silent (with a small exception for the activities
 *     toggle UI and the photo-upload R2 store — see Layer 3 plan, Issue B).
 *   - Every waitForEvent is wrapped in try/catch. On timeout we delete the
 *     active sent message (to keep the chat clean) and jump to synthesis
 *     with whatever data we have. The instance ends cleanly — no errored
 *     state for users who walk away mid-flow.
 *   - Step bodies are idempotent via `wf_${instanceId}_${stepName}` KV
 *     markers. Even if a step throws after a Telegram send (e.g. transient
 *     network blip after sendMessage delivered), the retry sees the marker
 *     and skips the send. No duplicate keyboards.
 *   - Extreme scores (0/1/9/10) follow the same flow as 2-8. No special
 *     skip-emotions path. The persona handles severity tone in the ack.
 *
 * Flow:
 *   0. quiet-hours-check (skippable via payload.respect_quiet_hours=false)
 *   1. send-score-poll        -> registers poll, starts KV flow cache
 *   2. waitForEvent('score_received')
 *   3. process-score          -> D1 save, score ack, emotion buttons
 *   4. waitForEvent('emotions_done')
 *   5. process-emotions       -> D1 save, background tagger, emotions ack
 *   6. send-activities-keyboard
 *   7. waitForEvent('activities_done')  (D1 save happens in callback per Issue B)
 *   8. send-photo-prompt
 *   9. waitForEvent('photo_done')  (D1 save happens in upload handler)
 *  10. send-sleep-keyboard
 *  11. waitForEvent('sleep_logged')
 *  12. process-sleep          -> D1 save sleep_hours
 *  13. fire-synthesis         (ALWAYS runs, even after a timeout abort)
 *
 * Payload:
 *   { chatId, userId, threadId, today,
 *     source: 'cron_poll' | 'manual_command',
 *     respect_quiet_hours: boolean }
 */
export class MoodEveningCheckinWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const {
			chatId,
			userId,
			threadId,
			today,
			source = 'cron_poll',
			respect_quiet_hours = true,
		} = event.payload || {};

		if (!chatId || !userId || !today) {
			throw new Error('Missing chatId/userId/today in workflow payload');
		}

		const env = this.env;
		const instanceId = event.instanceId;
		const startedAtMs = event.timestamp?.getTime?.() || Date.now();
		const STEP_TIMEOUT = '4 hours';

		// Idempotency marker helpers. Prevents duplicate Telegram sends if a
		// step throws after the network round-trip succeeded.
		const idemKey = (stepName) => `wf_${instanceId}_${stepName}`;
		const idemGet = async (stepName) => {
			try { return await env.CHAT_KV.get(idemKey(stepName), { type: 'json' }); }
			catch { return null; }
		};
		const idemSet = async (stepName, value) => {
			await env.CHAT_KV.put(idemKey(stepName), JSON.stringify(value || {}), {
				expirationTtl: 86400,
			});
		};

		// State threaded through the workflow. Message IDs captured at each
		// send step so the timeout cleanup branches know what to delete.
		const messageIds = {};
		let aborted = false;
		let score = null;
		let emotions = [];
		let sleepHours = null;
		let sleepSkipped = false;

		// ----- 0. Quiet-hours check (defensive) -----
		// Decision per Issue A: cron passes respect_quiet_hours=true,
		// /mood passes false (user-initiated action bypasses).
		if (respect_quiet_hours) {
			const isQuiet = await step.do('quiet-hours-check', {
				retries: { limit: 1, delay: '2 seconds', backoff: 'constant' },
				timeout: '10 seconds',
			}, async () => {
				const { isQuietTime } = await import('../tools/quietHours');
				return await isQuietTime(env, chatId);
			});
			if (isQuiet) {
				return { status: 'skipped', reason: 'quiet_hours', instanceId };
			}
		}

		// ----- 1. Send the score poll -----
		const pollResult = await step.do('send-score-poll', {
			retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
			timeout: '15 seconds',
		}, async () => {
			const cached = await idemGet('send-score-poll');
			if (cached) return cached;

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

			const pollId = json.result.poll.id;
			const msgId = json.result.message_id;
			const result = { pollId, msgId };

			// Mark idempotency BEFORE downstream setup so a retry skips the send.
			await idemSet('send-score-poll', result);

			// Route poll answers back to this workflow. Reuses existing key shape
			// so the existing index.js dispatch logic picks it up unchanged.
			await env.CHAT_KV.put(`mood_poll_${pollId}`, JSON.stringify({
				chatId, threadId, type: 'mood_checkin', sentAt: Date.now(),
				source, workflowId: instanceId,
			}), { expirationTtl: 86400 });

			// Write-through cache for AI tools (commit_journal_entry,
			// isAwaitingPhoto, etc.). Replaces the safety-net role moodFlow.js
			// used to fill, retains the AI-tool integration.
			const moodFlow = await import('../lib/moodFlow');
			await moodFlow.startFlow(env, chatId, source).catch(() => {});

			return result;
		});
		messageIds.poll = pollResult.msgId;

		// ----- 2. Wait for score -----
		try {
			const scoreEvent = await step.waitForEvent('await-score', {
				type: 'score_received',
				timeout: STEP_TIMEOUT,
			});
			score = scoreEvent?.payload?.score;
		} catch (e) {
			await step.do('cleanup-poll-message', { retries: { limit: 1 } }, async () => {
				if (messageIds.poll) {
					const telegram = await import('../lib/telegram');
					await telegram.deleteMessage(chatId, messageIds.poll, env).catch(() => {});
				}
			});
			aborted = true;
		}

		// ----- 3. Process score (D1 save, ack, emotion buttons) -----
		if (!aborted && score != null) {
			const processResult = await step.do('process-score', {
				retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			}, async () => {
				const cached = await idemGet('process-score');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				const moodFlow = await import('../lib/moodFlow');
				const telegram = await import('../lib/telegram');

				// D1 save
				await moodStore.upsertEntry(env, userId, today, 'evening', {
					mood_score: score,
					source,
				});

				// Advance write-through cache (for AI tools that read it).
				await moodFlow.advanceStage(env, chatId, userId).catch(() => {});

				// Run score ack via CF AI cascade (cheap, falls through to fixed text
				// if cascade fails).
				const { runScoreAck } = await import('../services/moodMicroAck');
				const { personas } = await import('../config/personas');
				const flow = await moodFlow.getFlow(env, chatId);
				let ackText;
				try {
					ackText = await runScoreAck(env, userId, score, flow, personas.xaridotis.instruction);
				} catch (ackErr) {
					ackText = 'Got it. Tap below to share what you are feeling.';
				}

				// Emotion buttons sent for EVERY score (extreme-score exception removed
				// per Layer 3 decision 4). The persona's tone shifts based on the score
				// inside the ack text itself.
				const btns = {
					inline_keyboard: [[
						{ text: '☀️ Positive', callback_data: 'mood_cat_positive', style: 'success' },
						{ text: '🌧 Negative', callback_data: 'mood_cat_negative', style: 'danger' }
					]]
				};
				const sendRes = await telegram.sendMessage(chatId, threadId, ackText, env, null, btns);
				const msgId = sendRes?.result?.message_id;

				// Mark the step as done IMMEDIATELY after the user-visible send. If anything
				// below throws, a retry will see this marker and skip the re-send.
				const result = { msgId, ackText };
				await idemSet('process-score', result);

				// Best-effort history persistence. Failure here must NOT cause the
				// workflow step to retry, because the Telegram message has already gone out.
				try {
					const threadKey = `chat_${chatId}_${threadId}`;
					let hist = await env.CHAT_KV.get(threadKey, { type: 'json' }) || [];
					hist.push({ role: 'user', parts: [{ text: `[I just logged my mood as ${score}/10]` }] });
					hist.push({ role: 'model', parts: [{ text: ackText }] });
					if (hist.length > 24) hist = hist.slice(-24);
					await env.CHAT_KV.put(threadKey, JSON.stringify(hist), { expirationTtl: 604800 });
				} catch (histErr) {
					console.warn('process-score: history persist failed (non-fatal):', histErr.message);
				}

				return result;
			});
			messageIds.emotionButtons = processResult.msgId;
		}

		// ----- 4. Wait for emotions -----
		if (!aborted) {
			try {
				const emotionsEvent = await step.waitForEvent('await-emotions', {
					type: 'emotions_done',
					timeout: STEP_TIMEOUT,
				});
				emotions = emotionsEvent?.payload?.emotions || [];
			} catch (e) {
				await step.do('cleanup-emotion-buttons', { retries: { limit: 1 } }, async () => {
					if (messageIds.emotionButtons) {
						const telegram = await import('../lib/telegram');
						await telegram.deleteMessage(chatId, messageIds.emotionButtons, env).catch(() => {});
					}
				});
				aborted = true;
			}
		}

		// ----- 5. Process emotions (D1 save, tagger, ack) -----
		if (!aborted) {
			await step.do('process-emotions', {
				retries: { limit: 2, delay: '2 seconds' },
				timeout: '30 seconds',
			}, async () => {
				const cached = await idemGet('process-emotions');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				const moodFlow = await import('../lib/moodFlow');
				const telegram = await import('../lib/telegram');

				if (emotions.length > 0) {
					await moodStore.upsertEntry(env, userId, today, 'evening', {
						emotions: JSON.stringify(emotions),
					});
				}
				await moodFlow.advanceStage(env, chatId, userId).catch(() => {});

				// Background tagger — fire-and-forget. CF AI free tier, no need to
				// await before continuing.
				import('../services/cfAi').then(async ({ tagMoodEntry }) => {
					try {
						const todayEntry = await moodStore.getEntry(env, userId, today, 'evening');
						const parsed = todayEntry?.data
							? (typeof todayEntry.data === 'string' ? JSON.parse(todayEntry.data) : todayEntry.data)
							: {};
						const tags = await tagMoodEntry(env, parsed.mood_score, emotions, parsed.note);
						if (tags) {
							await moodStore.upsertEntry(env, userId, today, 'evening', { clinical_tags: tags });
						}
					} catch { /* tagger is best-effort */ }
				}).catch(() => {});

				// Emotions ack
				const { runEmotionsAck } = await import('../services/moodMicroAck');
				const { personas } = await import('../config/personas');
				const flow = await moodFlow.getFlow(env, chatId);
				let ackText;
				try {
					ackText = await runEmotionsAck(env, userId, emotions, flow, personas.xaridotis.instruction);
				} catch (ackErr) {
					ackText = 'Got it.';
				}
				await telegram.sendMessage(chatId, threadId, ackText, env);

				// Mark step as done IMMEDIATELY after the user-visible send. Retries
				// after this point will see the marker and skip the re-send.
				await idemSet('process-emotions', {});

				// Best-effort history persistence. Failure here must NOT cause the
				// workflow step to retry, because the Telegram message has already gone out.
				try {
					const threadKey = `chat_${chatId}_${threadId}`;
					let hist = await env.CHAT_KV.get(threadKey, { type: 'json' }) || [];
					const label = emotions.length
						? `[I selected emotions: ${emotions.join(', ')}]`
						: '[I finished emotion selection without picking any]';
					hist.push({ role: 'user', parts: [{ text: label }] });
					hist.push({ role: 'model', parts: [{ text: ackText }] });
					if (hist.length > 24) hist = hist.slice(-24);
					await env.CHAT_KV.put(threadKey, JSON.stringify(hist), { expirationTtl: 604800 });
				} catch (histErr) {
					console.warn('process-emotions: history persist failed (non-fatal):', histErr.message);
				}

				return {};
			});
		}

		// ----- 6. Send activities keyboard -----
		// Activities toggle UI lives in the callback handler (per Issue B). The
		// workflow only renders the initial keyboard. The callback handles
		// taps and commits to D1 when Done is pressed.
		if (!aborted) {
			const actResult = await step.do('send-activities-keyboard', {
				retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
				timeout: '15 seconds',
			}, async () => {
				const cached = await idemGet('send-activities-keyboard');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				const moodFlow = await import('../lib/moodFlow');
				const { buildActivitiesKeyboard } = await import('../tools/moodKeyboards');

				const alreadyLogged = await moodStore.getTodayActivities(env, userId, today).catch(() => []);
				const keyboard = buildActivitiesKeyboard('new', alreadyLogged, [], []);

				const payload = {
					chat_id: chatId,
					text: 'What activities did you do today? Tap to add.',
					reply_markup: keyboard,
				};
				if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

				const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const json = await res.json();
				if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
				const msgId = json.result?.message_id;

				// Seed the activities pending state for the callback handler.
				await moodFlow.initActivitiesPending(env, chatId, msgId).catch(() => {});

				const result = { msgId };
				await idemSet('send-activities-keyboard', result);
				return result;
			});
			messageIds.activitiesKeyboard = actResult.msgId;

			// ----- 7. Wait for activities -----
			try {
				await step.waitForEvent('await-activities', {
					type: 'activities_done',
					timeout: STEP_TIMEOUT,
				});
				// D1 save happens in the callback (Issue B). Workflow no-ops here.
			} catch (e) {
				await step.do('cleanup-activities-keyboard', { retries: { limit: 1 } }, async () => {
					if (messageIds.activitiesKeyboard) {
						const telegram = await import('../lib/telegram');
						await telegram.deleteMessage(chatId, messageIds.activitiesKeyboard, env).catch(() => {});
					}
				});
				aborted = true;
			}
		}

		// ----- 8. Send photo prompt -----
		if (!aborted) {
			const photoStepResult = await step.do('send-photo-prompt', {
				retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
				timeout: '15 seconds',
			}, async () => {
				const cached = await idemGet('send-photo-prompt');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				const moodFlow = await import('../lib/moodFlow');

				const hasPhoto = await moodStore.hasPhotoLoggedToday(env, userId).catch(() => false);
				if (hasPhoto) {
					const result = { skipped: true, reason: 'photo_already_today' };
					await idemSet('send-photo-prompt', result);
					return result;
				}

				const payload = {
					chat_id: chatId,
					text: 'Got a photo from today? Send it whenever, or tap Skip.',
					reply_markup: { inline_keyboard: [[{ text: 'Skip photo', callback_data: 'mood_photo|skip' }]] },
				};
				if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);

				const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const json = await res.json();
				if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
				const msgId = json.result?.message_id;

				await moodFlow.initPhotoPending(env, chatId, msgId).catch(() => {});

				const result = { msgId, skipped: false };
				await idemSet('send-photo-prompt', result);
				return result;
			});
			messageIds.photoPrompt = photoStepResult.msgId;

			// ----- 9. Wait for photo -----
			// Only wait if we actually rendered the prompt. If photo was already
			// logged today, photoStepResult.skipped is true → fall straight through.
			if (!photoStepResult.skipped) {
				try {
					await step.waitForEvent('await-photo', {
						type: 'photo_done',
						timeout: STEP_TIMEOUT,
					});
				} catch (e) {
					await step.do('cleanup-photo-prompt', { retries: { limit: 1 } }, async () => {
						if (messageIds.photoPrompt) {
							const telegram = await import('../lib/telegram');
							await telegram.deleteMessage(chatId, messageIds.photoPrompt, env).catch(() => {});
						}
					});
					aborted = true;
				}
			}
		}

		// ----- 10. Send sleep keyboard -----
		if (!aborted) {
			const sleepStepResult = await step.do('send-sleep-keyboard', {
				retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
				timeout: '15 seconds',
			}, async () => {
				const cached = await idemGet('send-sleep-keyboard');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				const hasSleep = await moodStore.hasSleepLoggedToday(env, userId, today).catch(() => false);
				if (hasSleep) {
					const result = { skipped: true };
					await idemSet('send-sleep-keyboard', result);
					return result;
				}

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
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const json = await res.json();
				if (!json.ok) throw new Error(`sendMessage failed: ${json.description || 'unknown'}`);
				const msgId = json.result?.message_id;

				const result = { msgId, skipped: false };
				await idemSet('send-sleep-keyboard', result);
				return result;
			});
			messageIds.sleepKeyboard = sleepStepResult.msgId;

			// ----- 11. Wait for sleep -----
			if (!sleepStepResult.skipped) {
				try {
					const sleepEvent = await step.waitForEvent('await-sleep', {
						type: 'sleep_logged',
						timeout: STEP_TIMEOUT,
					});
					sleepHours = sleepEvent?.payload?.sleep_hours;
					sleepSkipped = sleepEvent?.payload?.skipped === true;
				} catch (e) {
					await step.do('cleanup-sleep-keyboard', { retries: { limit: 1 } }, async () => {
						if (messageIds.sleepKeyboard) {
							const telegram = await import('../lib/telegram');
							await telegram.deleteMessage(chatId, messageIds.sleepKeyboard, env).catch(() => {});
						}
					});
					aborted = true;
				}
			}
		}

		// ----- 12. Process sleep (D1 save) -----
		if (!aborted && sleepHours != null && !sleepSkipped) {
			await step.do('process-sleep', {
				retries: { limit: 2, delay: '2 seconds' },
				timeout: '10 seconds',
			}, async () => {
				const cached = await idemGet('process-sleep');
				if (cached) return cached;

				const moodStore = await import('../services/moodStore');
				await moodStore.upsertEntry(env, userId, today, 'evening', {
					sleep_hours: sleepHours,
					source,
				});

				await idemSet('process-sleep', { sleepHours });
				return { sleepHours };
			});
		}

		// ----- 13. Fire synthesis (ALWAYS, even after abort) -----
		// Even if the user walked away mid-flow, we still fire the synthesis
		// with the data we collected. Better to leave them a partial reflection
		// than nothing at all.
		const synthResult = await step.do('fire-synthesis', {
			retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
			timeout: '120 seconds',
		}, async () => {
			const cached = await idemGet('fire-synthesis');
			if (cached) return cached;

			const guardKey = `mood_synthesis_fired_${chatId}_${today}`;
			// Guard against double-send if any legacy path also tries to fire
			// synthesis. Set first; idempotent.
			await env.CHAT_KV.put(guardKey, '1', { expirationTtl: 26 * 3600 });

			const { runSynthesisCascade } = await import('../services/moodSynthesis');
			const { personas } = await import('../config/personas');

			const synth = await runSynthesisCascade(env, userId, startedAtMs, personas.xaridotis.instruction);

			if (synth?.text) {
				// Typing indicator before the long synthesis text lands.
				try {
					const tPayload = { chat_id: chatId, action: 'typing' };
					if (threadId && threadId !== 'default') tPayload.message_thread_id = Number(threadId);
					await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendChatAction`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(tPayload),
					});
				} catch { /* non-fatal */ }

				const payload = { chat_id: chatId, text: synth.text, parse_mode: 'HTML' };
				if (threadId && threadId !== 'default') payload.message_thread_id = Number(threadId);
				await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
			}

			// End the KV-side flow tracker and clear the active check-in flag.
			const moodFlow = await import('../lib/moodFlow');
			await moodFlow.endFlow(env, chatId).catch(() => {});
			await env.CHAT_KV.delete(`health_checkin_active_${chatId}`).catch(() => {});

			const result = {
				source: synth?.source,
				ms: synth?.ms,
				textLen: synth?.text?.length || 0,
			};
			await idemSet('fire-synthesis', result);
			return result;
		});

		return {
			status: aborted ? 'partial' : 'completed',
			instanceId,
			score,
			emotionCount: emotions.length,
			sleepHours,
			sleepSkipped,
			synthesisSource: synthResult?.source,
			synthesisMs: synthResult?.ms,
		};
	}
}
