import { handleMessage, handleCallback } from './bot/handlers';
import { handleInlineQuery } from './bot/inlineHandler';
import * as reminderStore from './services/reminderStore';
import * as moodStore from './services/moodStore';
import * as memoryStore from './services/memoryStore';
import * as vectorStore from './services/vectorStore';
import * as episodeStore from './services/episodeStore';
import * as telegram from './lib/telegram';
import { generateSpeech } from './lib/tts';
import { generateShortResponse, generateWithFallback } from './lib/ai/gemini';
import { storeDiscoveredEffect } from './tools/effect';
import { personas, MENTAL_HEALTH_DIRECTIVE } from './config/personas';
import { ARCHITECTURE_SUMMARY } from './config/architecture';
import { getSchedule, matchesSchedule } from './config/schedules';
import { toolRegistry } from './tools/index';
import { log } from './lib/logger';
import { wrapD1 } from './lib/db';

// Export Workflow classes for Cloudflare Workflows binding
export { MemoryConsolidationWorkflow } from './workflows/memoryConsolidation';
export { DeepResearchWorkflow } from './workflows/deepResearch';

const BIZ_CONN_TTL = 2592000; // 30 days

// Known effect IDs to emoji mapping (for discovery logging)
const KNOWN_EFFECT_EMOJIS = {
	"5159385139981059251": "❤️",
	"5107584321108051014": "👍",
	"5104858069142078462": "👎",
	"5070445174516318631": "🔥",
	"5066970843586925436": "🎉",
	"5046589136895476101": "💩",
	"5104841245755180586": "❤️",  // alternate hearts ID
};

function extractEffectEmoji(msg, effectId) {
	// First check if we already know this effect ID
	if (KNOWN_EFFECT_EMOJIS[effectId]) return KNOWN_EFFECT_EMOJIS[effectId];

	// Try to extract from the message text
	const text = (msg.text || "").trim();
	if (!text) return null;

	// If the message is just a single emoji (up to 4 bytes), use it
	if (text.length <= 4) return text;

	// Try to extract the first emoji from any message
	const emojiMatch = text.match(/(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
	return emojiMatch ? emojiMatch[0] : `effect_${effectId.slice(-6)}`;
}

// ---- Health Check-in Scheduler ----
// Runs inside the cron handler. Checks London time and sends check-ins as Nightfall.
async function handleHealthCheckIns(env) {
	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat: chatId == userId
	const userTz = await env.CHAT_KV.get(`timezone_${chatId}`) || 'Europe/London';
	const now = new Date();
	const localTime = new Date(now.toLocaleString('en-US', { timeZone: userTz }));
	const hour = localTime.getHours();
	const minute = localTime.getMinutes();
	const threadId = 'default';
	const today = localTime.toISOString().split('T')[0];
	const currentMins = hour * 60 + minute;

	// Load schedules
	const morning = await getSchedule(env, 'morning_checkin');
	const midday = await getSchedule(env, 'midday_checkin');
	const evening = await getSchedule(env, 'evening_checkin');

	const morningMins = morning.hour * 60 + (morning.minute || 0);
	const middayMins = midday.hour * 60 + (midday.minute || 0);
	const eveningMins = evening.hour * 60 + (evening.minute || 0);

	// Polite deferral: if the user messaged within the last 20 minutes, wait
	const lastSeenStr = await env.CHAT_KV.get(`last_seen_${chatId}`);
	const lastSeen = lastSeenStr ? parseInt(lastSeenStr) : 0;
	const isUserActive = (Date.now() - lastSeen) < 20 * 60 * 1000;

	// Morning check-in (window: morning schedule until midday schedule)
	if (currentMins >= morningMins && currentMins < middayMins) {
		const key = `health_checkin_morning_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		if (isUserActive) return;

		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'morning', { expirationTtl: 1800 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, userId, 'morning');
		if (alreadyLogged) return;

		// Conversational medication check (no buttons)
		const morningGreeting = await generateShortResponse(
			`Generate a 1-2 sentence morning greeting for Roman. It is morning in London. Weave in a brief, natural reference to one of his interests (coffee, gym, anime, photography, cooking, or music). Ask how he slept and casually ask if he has taken his morning medication. Keep it warm and conversational, like a friend checking in. Do NOT list medication names.`,
			personas.xaridotis.instruction, env
		) || 'Morning. How did you sleep? Have you taken your meds yet?';

		await telegram.sendMessage(chatId, threadId, morningGreeting, env);
		// Track that we're waiting for medication confirmation
		await env.CHAT_KV.put(`med_pending_${chatId}`, 'morning', { expirationTtl: 7200 });
		await env.CHAT_KV.put(`nudge_pending_morning_${chatId}`, String(Date.now()), { expirationTtl: 3600 });
	}

	// Midday check-in (window: midday schedule until evening schedule)
	else if (currentMins >= middayMins && currentMins < eveningMins) {
		const key = `health_checkin_midday_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		if (isUserActive) return;

		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'midday', { expirationTtl: 1800 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, userId, 'midday');
		if (alreadyLogged) return;

		// Conversational medication check (no buttons)
		const middayGreeting = await generateShortResponse(
			`Generate a 1-2 sentence midday check-in for Roman. It is midday in London. Casually ask if he has taken his meds. Keep it brief and natural. Do NOT list specific medication names. Do NOT use buttons or ask for a number.`,
			personas.xaridotis.instruction, env
		) || 'Quick midday check. Have you taken your meds?';

		await telegram.sendMessage(chatId, threadId, middayGreeting, env);
		await env.CHAT_KV.put(`med_pending_${chatId}`, 'midday', { expirationTtl: 7200 });
		await env.CHAT_KV.put(`nudge_pending_midday_${chatId}`, String(Date.now()), { expirationTtl: 3600 });
	}

	// Evening check-in (window: evening schedule until midnight)
	else if (currentMins >= eveningMins) {
		const key = `health_checkin_evening_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		if (isUserActive) return;

		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 1800 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, userId, 'evening');
		if (alreadyLogged) return;

		// Send mood poll instead of checklist buttons
		await sendMoodPoll(chatId, threadId, env);
		await env.CHAT_KV.put(`nudge_pending_evening_${chatId}`, String(Date.now()), { expirationTtl: 7200 });
	}
}

// ---- Medication Nudge ----
// If a check-in was sent but not responded to within 30 minutes, send a gentle nudge.
async function handleMedicationNudge(env) {
	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat: chatId == userId
	const now = Date.now();
	const londonTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const hour = londonTime.getHours();

	// Only check during relevant hours to avoid unnecessary D1 queries
	if (hour < 8 || hour > 21) return;
	const threadId = 'default';

	for (const type of ['morning', 'midday', 'evening']) {
		const nudgeKey = `nudge_pending_${type}_${chatId}`;
		const pendingTime = await env.CHAT_KV.get(nudgeKey);
		if (!pendingTime) continue;

		// Check if 30 minutes have passed
		if ((now - parseInt(pendingTime)) < 30 * 60 * 1000) continue;

		// Check if the user has since responded (data was logged)
		const logged = await moodStore.hasCheckedInToday(env, userId, type);
		if (logged) {
			await env.CHAT_KV.delete(nudgeKey);
			continue;
		}

		// Send the nudge and clear the flag
		if (type === 'morning' || type === 'midday') {
			// Check if medication was already confirmed conversationally
			const medPending = await env.CHAT_KV.get(`med_pending_${chatId}`);
			if (!medPending) {
				// Medication was confirmed, just clear the nudge
				await env.CHAT_KV.delete(nudgeKey);
				continue;
			}
			// Medication still pending: gentle conversational follow-up
			const nudge = await generateShortResponse(
				`You asked Roman about his medication earlier but he hasn't confirmed taking it yet. Send a brief, gentle 1-sentence follow-up. Do not be pushy or clinical. Just a casual nudge like a friend would. Example tone: "Hey, just checking — did you get round to taking your meds?"`,
				personas.xaridotis.instruction, env
			) || 'Just checking — did you manage to take your meds?';
			await telegram.sendMessage(chatId, threadId, nudge, env);
		} else {
			// Evening: nudge about mood check-in
			const nudge = await generateShortResponse(
				`The evening mood check-in was sent earlier but Roman hasn't responded. Send a brief 1-sentence gentle reminder about the mood poll. Keep it casual.`,
				personas.xaridotis.instruction, env
			) || 'Your evening check-in is still waiting when you have a moment.';
			await telegram.sendMessage(chatId, threadId, nudge, env);
		}
		await env.CHAT_KV.delete(nudgeKey);
	}
}

// ---- Weekly Mental Health Report ----
// Runs Sunday at 20:00 London time. Pulls the week's mood data and generates an analysis.
async function handleWeeklyReport(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'weekly_report');

	if (londonTime.getDay() !== schedule.day || londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const threadId = 'default';
	const today = londonTime.toISOString().split('T')[0];
	const reportKey = `weekly_report_${today}`;

	if (await env.CHAT_KV.get(reportKey)) return;
	await env.CHAT_KV.put(reportKey, '1', { expirationTtl: 86400 * 2 });

	try {
		// Pull the last 7 days of mood data
		const entries = await moodStore.getWeeklySummary(env, userId);
		if (!entries.length) {
			await telegram.sendMessage(chatId, threadId,
				`<b>Weekly Report</b>\n\nNo mood data recorded this week. Start logging with /mood to build your pattern history.`, env);
			return;
		}

		const analysisPrompt = `You are Nightfall conducting a transparent, clinical-grade weekly review.
You are an Active Data Mirror. Show the user their patterns, prove exactly how you found them, and ask them to make meaning of it.

DATA:
${JSON.stringify(entries, null, 2)}

Structure your response exactly like this:

1. The Observation: State the primary pattern or correlation you noticed this week in one sentence.

2. The Data Audit: Provide exact proof using bullet points.
   List exact dates and scores.
   List exact tags or variables present.
   If there is variation, state the falsifying data (e.g., "However, on Wednesday you logged a 5 with the same tags").
   If data is uniform, state: "This pattern was consistent across all logged days."

3. The Hand-off: Ask ONE curious, AEDP-aligned question asking the user what they make of this data or what feels like the biggest block to changing it.
4. Schedule Check: Look at the created_at timestamps vs entry_type. Morning check-ins are sent at 08:30, evening at 20:30. If the user consistently logs 1.5+ hours late, proactively ask if they want to shift the check-in time to match their actual routine.

Do not give advice. Do not prescribe solutions. Present the data, prove your work, and hand the agency back to the user.`;

		const report = await generateShortResponse(analysisPrompt, personas.xaridotis.instruction, env);

		if (report) {
			await telegram.sendMessage(chatId, threadId,
				`<b>Your Weekly Mental Health Report</b>\n\n${report}`, env);

			// Save the weekly observation for long-term pattern tracking (Importance: 2)
			await memoryStore.saveMemory(env, userId, 'insight', `Weekly Observation (${today}): ${report}`, 2);
		}
	} catch (e) {
		console.error('Weekly report error:', e.message);
	}
}

// ---- Mid-Week Accountability Nudge ----
// Runs Wednesday at 16:00 London time. Checks for active homework or coping strategies.
async function handleAccountabilityNudge(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'accountability_nudge');

	if (londonTime.getDay() !== schedule.day || londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];
	const nudgeKey = `accountability_nudge_${today}`;

	if (await env.CHAT_KV.get(nudgeKey)) return;
	await env.CHAT_KV.put(nudgeKey, '1', { expirationTtl: 86400 });

	try {
		const memories = await memoryStore.getRecentTherapeuticMemories(env, userId, 7);
		if (!memories.length) return;

		// Fetch the most recent weekly insight for clinical context
		const recentInsights = await memoryStore.getMemoriesByCategory(env, userId, 'insight', 1);
		const latestInsight = recentInsights.length > 0 ? recentInsights[0].fact : 'None';

		const prompt = `You are Nightfall.
Pending homework/coping strategies this week: ${JSON.stringify(memories)}
Most recent weekly observation: ${latestInsight}

Draft a gentle, proactive mid-week check-in.
1. Ask about their progress with the homework/coping strategies.
2. If (and ONLY if) it makes logical clinical sense, weave in the recent weekly observation as context for why they might be finding the homework easy or difficult right now.
3. If they have repeatedly avoided a task, gently hold up a mirror: "I notice we have paused on this a few times..." and ask what the biggest block is.

Keep it to 2-3 sentences. Be warm and curious, not demanding.`;

		const msg = await generateShortResponse(prompt, personas.xaridotis.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', `<b>Mid-Week Check-in</b>\n\n${msg}`, env);
		}
	} catch (e) {
		console.error('Accountability nudge error:', e.message);
	}
}

// ---- Monthly Memory Consolidation ("REM Sleep") ----
// Runs on the 1st of every month at 03:00 London time.
async function handleMemoryConsolidation(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'memory_consolidation');

	if (londonTime.getDate() !== schedule.date || londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const month = londonTime.toISOString().split('-').slice(0, 2).join('-');
	const runKey = `rem_consolidation_${month}`;

	if (await env.CHAT_KV.get(runKey)) return;
	await env.CHAT_KV.put(runKey, '1', { expirationTtl: 86400 * 5 });

	try {
		// Trigger the durable Workflow instead of running inline
		if (env.MEMORY_WORKFLOW) {
			await env.MEMORY_WORKFLOW.create({
				id: `rem-sleep-${month}`,
				params: { chatId, userId }
			});
			log.info('workflow_triggered', { workflow: 'memory-consolidation', month });
		} else {
			// Fallback: run inline if Workflow binding not available
			await memoryStore.consolidateMemories(env, userId);
			await telegram.sendMessage(chatId, 'default',
				'<i>Did some deep memory consolidation overnight. Your saved memories are organised and ready for the new month.</i>', env);
		}
	} catch (e) {
		log.error('consolidation_error', { msg: e.message });
	}
}

// ---- Mood Poll System ----
// Condensed 0-10 bipolar mood scale descriptions (max 100 chars per option)
const MOOD_POLL_OPTIONS = [
	'0: Crisis. Suicidal thoughts, no movement, total despair.',
	'1: Severe. Hopeless, guilt, feels impossible to function.',
	'2: Low. Persistent sadness, withdrawn, little motivation.',
	'3: Struggling. Anxious, irritable, getting through the day.',
	'4: Below average. Flat mood, low energy but managing.',
	'5: Neutral. Neither good nor bad, steady baseline.',
	'6: Good. Positive outlook, engaged, making good choices.',
	'7: Very good. Productive, social, optimistic and sharp.',
	'8: Elevated. High energy, racing thoughts, reduced sleep.',
	'9: Hypomanic. Impulsive, grandiose, poor judgement.',
	'10: Manic. Reckless, detached from reality, dangerous.',
];

async function sendMoodPoll(chatId, threadId, env) {
	const pollRes = await telegram.sendPoll(chatId, threadId,
		'How do you feel right now?',
		MOOD_POLL_OPTIONS,
		env, { is_anonymous: false }
	);
	if (pollRes?.ok) {
		const pollId = pollRes.result.poll.id;
		await env.CHAT_KV.put(`mood_poll_${pollId}`, JSON.stringify({
			chatId, threadId, type: 'mood_checkin', sentAt: Date.now()
		}), { expirationTtl: 86400 });
		log.info('mood_poll_sent', { chatId, pollId });
	}
	return pollRes;
}

async function handleMoodPollAnswer(userId, chatId, threadId, score, env) {
	const today = new Date().toISOString().split('T')[0];
	log.info('mood_poll_score', { userId, chatId, score });

	// Save mood score (keyed by user, not chat)
	await moodStore.upsertEntry(env, userId, today, 'evening', { mood_score: score });

	// Build context-aware response using recent mood history and memories
	const moodHistory = await moodStore.getHistory(env, userId, 30);
	const memoryCtx = await memoryStore.getFormattedContext(env, userId);
	const semanticCtx = await vectorStore.getSemanticContext(env, userId, `mood score ${score} how I feel`);
	const therapeuticNotes = await env.DB.prepare(
		`SELECT category, fact FROM memories WHERE user_id = ? AND category IN ('pattern','trigger','schema','insight','homework') ORDER BY created_at DESC LIMIT 10`
	).bind(userId).all().then(r => r.results || []);

	const recentScores = moodHistory.slice(0, 7).map(e => {
		const parsed = typeof e.data === 'string' ? JSON.parse(e.data || '{}') : (e.data || {});
		const emotions = parsed.emotions?.length ? '(' + parsed.emotions.join(', ') + ')' : '';
		return `${e.date}: ${parsed.mood_score ?? '?'}/10 ${emotions}`;
	}).join('\n');

	const clinicalNotes = therapeuticNotes.map(n => `[${n.category}] ${n.fact}`).join('\n');

	// Retrieve relevant past episodes (CoALA episodic memory)
	const relevantEpisodes = await episodeStore.getRecentEpisodes(env, userId, 5, score <= 3 ? 'crisis' : null).catch(() => []);
	const episodeCtx = episodeStore.formatEpisodesForContext(relevantEpisodes);

	let contextPrompt;
	if (score <= 1) {
		contextPrompt = `CRISIS RESPONSE. The user scored ${score}/10 (severe depression/crisis).
Recent mood history:\n${recentScores}
Clinical notes:\n${clinicalNotes}
${episodeCtx}
${semanticCtx}

Respond with deep compassion. Mention Samaritans (116 123) and SHOUT (text 85258). If past episodes show what helped before, reference that gently. Ask what has been weighing on them.`;
	} else if (score >= 9) {
		contextPrompt = `MANIA ALERT. The user scored ${score}/10 (mania/hypomania).
Recent mood history:\n${recentScores}
Clinical notes:\n${clinicalNotes}
${episodeCtx}
${semanticCtx}

Acknowledge calmly without amplifying the energy. Ask ONE question about sleep or safety. Note any escalating pattern. If past episodes show precedent, reference it.`;
	} else {
		contextPrompt = `The user scored ${score}/10 on their mood check-in today.
Recent mood history (last 7 days):\n${recentScores}
Clinical notes:\n${clinicalNotes}
${episodeCtx}
${semanticCtx}

Respond naturally:
1. Acknowledge the score briefly.
2. Compare to recent days. Note any trends (improving, declining, stable).
3. If past episodes are available, reference what worked or didn't work in similar situations.
4. From a therapeutic perspective, share one observation about their recent pattern.
5. Ask them to tap the emotion buttons below to log how they are feeling.
Keep it warm, concise, and clinically aware. Do not list every data point. Synthesise.`;
	}

	try {
		const response = await generateShortResponse(contextPrompt, personas.xaridotis.instruction, env);
		const aiMsg = response || 'Tap below to tell me about your emotions.';

		// Show emotion buttons for normal range (2-8)
		const btns = (score >= 2 && score <= 8) ? {
			inline_keyboard: [[
				{ text: '☀️ Positive', callback_data: 'mood_cat_positive', style: 'success' },
				{ text: '🌧 Negative', callback_data: 'mood_cat_negative', style: 'danger' }
			]]
		} : undefined;

		await telegram.sendMessage(chatId, threadId, aiMsg, env, null, btns);
	} catch (e) {
		log.error('mood_poll_response_error', { msg: e.message });
		await telegram.sendMessage(chatId, threadId, 'How are your emotions today?', env, null, {
			inline_keyboard: [[
				{ text: '☀️ Positive', callback_data: 'mood_cat_positive', style: 'success' },
				{ text: '🌧 Negative', callback_data: 'mood_cat_negative', style: 'danger' }
			]]
		});
	}
}

// ---- Spontaneous "Thinking of You" Outreach ----
// Runs every hour 10:00-19:00 London time, triggers ~5% of the time (avg once every few days).
async function handleSpontaneousOutreach(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const hour = londonTime.getHours();

	// Only during sociable hours
	if (hour < 10 || hour > 19) return;

	// 5% chance of triggering (runs every minute, so ~3 times per hour window = ~0.15 triggers/hour)
	if (Math.random() > 0.05) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];

	// Max one spontaneous message per day = `spontaneous_${today}`;
	if (await env.CHAT_KV.get(outreachKey)) return;
	await env.CHAT_KV.put(outreachKey, '1', { expirationTtl: 86400 });

	// Check when we last spoke (don't double-text)
	const lastSeenStr = await env.CHAT_KV.get(`last_seen_${chatId}`);
	const lastSeen = lastSeenStr ? parseInt(lastSeenStr) : 0;
	const hoursSinceLastChat = Math.round((Date.now() - lastSeen) / (1000 * 60 * 60));
	if (hoursSinceLastChat < 3) return;

	try {
		// Pull memories with a mix of types for contextual check-ins
		const allMemories = await memoryStore.getMemories(env, userId, 50);
		const casualMemories = allMemories.filter(m => !['pattern', 'schema', 'trigger', 'avoidance'].includes(m.category));
		if (!casualMemories.length) return;

		// Prefer recent implicit observations and discoveries for natural check-ins
		const implicit = casualMemories.filter(m => m.fact?.startsWith('Implicit:'));
		const discoveries = casualMemories.filter(m => m.category === 'discovery');
		const ideas = casualMemories.filter(m => m.category === 'idea' || m.category === 'brain_dump');
		const homework = allMemories.filter(m => m.category === 'homework');

		// Pick the most contextually interesting memory
		let chosenMemory;
		const roll = Math.random();
		if (homework.length > 0 && roll < 0.2) {
			// 20% chance: follow up on homework/goals
			chosenMemory = homework[Math.floor(Math.random() * homework.length)];
		} else if (implicit.length > 0 && roll < 0.5) {
			// 30% chance: reference something observed implicitly
			chosenMemory = implicit[Math.floor(Math.random() * implicit.length)];
		} else if (discoveries.length > 0 && roll < 0.75) {
			// 25% chance: share something learned during study
			chosenMemory = discoveries[Math.floor(Math.random() * discoveries.length)];
		} else {
			// 25% chance: random casual memory
			chosenMemory = casualMemories[Math.floor(Math.random() * casualMemories.length)];
		}

		const isFollowUp = chosenMemory.category === 'homework' || chosenMemory.fact?.startsWith('Implicit:');

		const prompt = isFollowUp
			? `You remembered this about Roman: "${chosenMemory.fact}".
It has been about ${hoursSinceLastChat} hours since you last spoke.
Send a natural, casual check-in based on this. Like a friend who remembered something and is following up.
${hoursSinceLastChat > 24 ? 'It has been a while, so check how he is doing.' : 'Keep it light and brief.'}
Keep it to 1-2 sentences. Be warm but not pushy.`
			: `You just thought of this: "${chosenMemory.fact}" (type: ${chosenMemory.category}).
It has been about ${hoursSinceLastChat} hours since you last spoke.
${chosenMemory.category === 'discovery' ? 'Present it as something you recently read and thought they would find interesting.' : 'Share a random observation or thought about it, like a friend texting out of the blue.'}
${hoursSinceLastChat > 24 ? 'Since it has been a while, you could naturally ask how they are doing too.' : ''}
Keep it to 1-2 sentences. DO NOT offer help. DO NOT be a therapist. Just share it naturally.`;

		const msg = await generateShortResponse(prompt, personas.xaridotis.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', msg, env);
		}
	} catch (e) {
		log.error('spontaneous_outreach_error', { msg: e.message });
	}
}

// ---- Weekly Curiosity Digest ----
// Runs Saturday at 10:00 London time. Searches for interesting developments in user's interests.
async function handleCuriosityDigest(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'curiosity_digest');

	if (londonTime.getDay() !== schedule.day || londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];
	const digestKey = `curiosity_digest_${today}`;

	if (await env.CHAT_KV.get(digestKey)) return;
	await env.CHAT_KV.put(digestKey, '1', { expirationTtl: 86400 * 2 });

	try {
		const { text: digest } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `Find the most interesting developments from THIS WEEK across these topics. Pick 3-4 of the most genuinely interesting items. For each write one punchy sentence explaining why it matters. Be selective not comprehensive. Skip anything boring.

Topics to search:
• AI and machine learning (new models, agent frameworks, reasoning breakthroughs, open-source releases)
• LLM engineering (prompt techniques, RAG advances, context innovations)
• Consumer technology (new gadgets, apps, platforms)
• Scientific discoveries (neuroscience, space, longevity, psychology)
• ServiceNow platform (new features, AI integrations, community updates)
• London events this weekend (food festivals, gigs, exhibitions, tech meetups)
• Anime and manga (seasonal highlights, studio announcements)
• Photography and drone technology
• Fitness and exercise science` }] }],
			{ tools: [{ googleSearch: {} }], temperature: 0.8 }
		);

		if (!digest || digest.length < 50) return;

		const personaKey = await env.CHAT_KV.get(`persona_${chatId}_default`) || 'tenon';
		const persona = personas.xaridotis;

		const formatPrompt = `You are ${persona.name || 'Tenon'}. Rewrite this digest into a casual message as if texting a friend things you found interesting this week. Mix in your reactions and opinions. Keep your personality. No headers or bullet points. Natural flowing text, 4-6 sentences.

Raw digest:
${digest}`;

		const msg = await generateShortResponse(formatPrompt, persona.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', `<b>Things I found interesting this week</b>\n\n${msg}`, env);

			// Save the raw discoveries as a memory so they feed into spontaneous outreach and conversations
			await memoryStore.saveMemory(env, userId, 'discovery', `Weekly research (${today}): ${digest.slice(0, 500)}`, 1);
		}
	} catch (e) {
		console.error('Curiosity digest error:', e.message);
	}
}

// ---- Autonomous Research Loop ----
// Runs Tuesday and Friday at 04:00 London time. Searches ONE random domain deeply.
async function handleAutonomousResearch(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const day = londonTime.getDay();
	const sched1 = await getSchedule(env, 'autonomous_research_1');
	const sched2 = await getSchedule(env, 'autonomous_research_2');

	const matchDay = (day === sched1.day || day === sched2.day);
	const matchHour = londonTime.getHours() === sched1.hour;
	if (!matchDay || !matchHour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];
	const key = `auto_research_${today}`;

	if (await env.CHAT_KV.get(key)) return;
	await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 * 2 });

	try {
		const domains = [
			'AI and LLM advancements (new models, agent frameworks, reasoning breakthroughs)',
			'Consumer technology news (new devices, apps, notable launches)',
			'Scientific breakthroughs (neuroscience, space, longevity, psychology)',
			'ServiceNow platform updates and AI integrations',
			'Drone photography and videography technology',
			'Anime and manga releases or studio announcements',
			'London food, coffee, and music events',
			'Exercise science and fitness research',
		];
		const randomDomain = domains[Math.floor(Math.random() * domains.length)];

		const { text } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `Find ONE highly interesting, concrete piece of news or breakthrough from the last 7 days regarding: ${randomDomain}. Explain what it is and why someone interested in AI, photography, fitness, cooking, and anime would care about it. Keep it to 2-3 sentences.` }] }],
			{ tools: [{ googleSearch: {} }], temperature: 0.7 }
		);
		if (text && text.length > 30) {
			await memoryStore.saveMemory(env, userId, 'discovery', `Research (${randomDomain.split('(')[0].trim()}): ${text}`, 1);
			console.log(`🧠 Autonomous research: ${randomDomain.split('(')[0].trim()}`);
		}
	} catch (e) {
		console.error('Autonomous research error:', e.message);
	}
}

// ---- Self-Improvement Advisor ----
// Runs on the 15th of every month at 05:00 London time.
// Researches best practices, compares against architecture, suggests improvements.
async function handleSelfImprovement(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'self_improvement');

	if (londonTime.getDate() !== schedule.date || londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const month = londonTime.toISOString().split('-').slice(0, 2).join('-');
	const key = `self_improve_${month}`;

	if (await env.CHAT_KV.get(key)) return;
	await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 * 5 });

	try {
		const { text: suggestions } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `You are a senior AI engineer reviewing a Telegram chatbot's architecture. Your job is to suggest concrete, actionable improvements.

CURRENT ARCHITECTURE:
${ARCHITECTURE_SUMMARY}

TASK:
1. Use Google Search to research the latest best practices for: AI chatbot UX, therapeutic AI companions, Telegram Bot API updates, Cloudflare Workers optimisations, and Gemini API new features.
2. Compare what you find against the current architecture above.
3. Identify exactly 3 high-impact improvements that are NOT already implemented.
4. For each improvement, explain: what it is, why it matters, and a rough implementation approach.

RULES:
- Only suggest things that are technically feasible with the existing stack (Cloudflare Workers, D1, KV, R2, Vectorize, Gemini API, Telegram Bot API).
- Do NOT suggest things already listed in the architecture.
- Prioritise user experience and therapeutic quality over engineering elegance.
- Be specific and concrete, not vague.` }] }],
			{ tools: [{ googleSearch: {} }], temperature: 0.7 }
		);

		if (!suggestions || suggestions.length < 100) return;

		// Save as a memory for future reference
		await memoryStore.saveMemory(env, userId, 'discovery', `Self-improvement suggestions (${month}): ${suggestions.slice(0, 500)}`, 1);

		// Send to the user
		const formatPrompt = `Rewrite these technical suggestions into a casual, conversational message. You are Tenon sharing ideas with Roman about how to improve the bot. Keep your dry wit. Present each suggestion as something you noticed while doing some reading, not as a formal report. 3-4 short paragraphs.

Raw suggestions:
${suggestions}`;

		const msg = await generateShortResponse(formatPrompt, personas.xaridotis.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', `<b>Monthly self-assessment</b>\n\n${msg}`, env);
		}
	} catch (e) {
		console.error('Self-improvement error:', e.message);
	}
}

// ---- Autonomous Architecture Evolution (Weekly Deep Search) ----
// Runs once a week. Searches one technology deeply, reads actual docs via read_webpage, suggests PRs.
// ---- Autonomous Architecture Evolution (Hourly Deep Search) ----
async function handleArchitectureEvolution(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));

	if (londonTime.getMinutes() !== 0) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const currentKey = `auto_architect_${londonTime.toISOString().slice(0, 13)}`;

	if (await env.CHAT_KV.get(currentKey)) return;
	await env.CHAT_KV.put(currentKey, '1', { expirationTtl: 3600 });

	try {
		const { GoogleGenAI } = await import('@google/genai');
		const { toolDefinitions } = await import('./tools/index'); // Import definitions
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const technologies = [
			'Cloudflare Workers D1 Vectorize latest updates',
			'Telegram Bot API recent changes new methods',
			'Google Gemini API Node SDK new features',
			'Cloudflare Workers performance best practices',
		];
		const randomTech = technologies[Math.floor(Math.random() * technologies.length)];

		// Phase 1: Search for the latest docs/updates
		const { text: searchText } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `Search for the latest updates or changes for: ${randomTech}. Find the most relevant official documentation URL. Return the URL on the first line, then a 2-sentence summary of what changed.` }] }],
			{ tools: [{ googleSearch: {} }], temperature: 0.5 }
		);

		if (!searchText || searchText.length < 30) return;

		// Phase 2: Deep-read the URL
		let deepContent = '';
		const urlMatch = searchText.match(/https?:\/\/[^\s)]+/);
		if (urlMatch && toolRegistry['read_webpage']) {
			try {
				const result = await toolRegistry['read_webpage'].execute({ url: urlMatch[0] });
				if (result.status === 'success') deepContent = `\n\nDOCUMENTATION FROM ${urlMatch[0]}:\n${(result.content || result.text || '').slice(0, 8000)}`;
			} catch { /* proceed */ }
		}

		// Phase 3: Compare against architecture and draft PR
		const { text: prText } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `You are a Principal Architect reviewing a Telegram bot.

SEARCH FINDINGS:
${searchText}
${deepContent}

CURRENT ARCHITECTURE:
${ARCHITECTURE_SUMMARY}

Compare findings against the architecture. If you find a concrete improvement NOT already implemented, draft a Pull Request:
1. What to change (specific file paths)
2. Why it matters
3. A code sketch of the key change

TRUSTED SOURCES: For health/medical use NHS, NICE, APA, WHO, BAP. For technical use official documentation.

If no improvement is needed, respond with exactly: NO_PR_NEEDED
Keep it under 500 words. End with: "Awaiting your manual review."` }] }],
			{ temperature: 0.5 }
		);

		if (prText && !prText.includes('NO_PR_NEEDED') && prText.length > 50) {
			await telegram.sendMessage(chatId, 'default', `<b>Architecture Deep Search</b>\n\n${prText}`, env, null, {
				inline_keyboard: [[
					{ text: '✅ Approve', callback_data: 'approve_pr', style: 'success' },
					{ text: '❌ Dismiss', callback_data: 'action_dismiss_pr', style: 'danger' }
				]]
			});
			await memoryStore.saveMemory(env, userId, 'discovery', `Architecture PR (${randomTech}): ${prText.slice(0, 300)}`, 1);
		}
	} catch (e) {
		console.error('Architecture evolution error:', e.message);
	}
}

// ---- Daily Study Session ----
// ---- Autonomous Living: Daily Study & Proactive Sharing ----
// Runs every hour during waking hours (7-23), triggers ~10% of the time (1-2x/day).
// Xaridotis picks a topic, researches it deeply, saves what it learned,
// and sometimes shares an insight naturally.
async function handleDailyStudy(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const hour = londonTime.getHours();

	// Sleep between 23:00 and 07:00
	if (hour < 7 || hour >= 23) return;

	// ~10% chance per hour = roughly 1-2 triggers per day
	if (Math.random() > 0.10) return;

	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];
	const studyKey = `daily_study_${today}`;

	// Max one study session per day
	if (await env.CHAT_KV.get(studyKey)) return;
	await env.CHAT_KV.put(studyKey, '1', { expirationTtl: 86400 });

	try {
		const studyTopics = [
			// Career & professional development
			'ServiceNow CAD certification exam preparation tips and key concepts',
			'ServiceNow ITSM best practices and latest platform updates',
			'ServiceNow certified implementation specialist study guide topics',
			'ServiceNow platform new features and AI integrations latest',

			// Coding & AI engineering
			'JavaScript ES2025 ES2026 new features and best practices',
			'Python programming practical projects for AI development',
			'building AI agents with LLMs latest techniques and frameworks',
			'Telegram Bot API latest features and advanced capabilities',
			'Cloudflare Workers advanced patterns and new features',
			'Google Gemini API latest updates and advanced tool use',

			// AI & technology news
			'latest AI developments new models and breakthroughs this week',
			'new iPhone iOS features and updates latest',
			'MacOS latest features and productivity tools',
			'latest consumer tech news phones laptops gadgets',

			// Therapeutic frameworks (deepening clinical knowledge)
			'AEDP therapy techniques for processing core emotions',
			'DBT distress tolerance skills practical exercises',
			'schema therapy abandonment schema healing approaches',
			'attachment theory anxious attachment practical strategies',
			'Internal Family Systems IFS parts work practical techniques',
			'ADHD emotional dysregulation coping strategies evidence-based',
			'bipolar disorder mood tracking best practices clinical',

			// Lifestyle & culture
			'best new cafes and restaurants London this month',
			'London food scene new openings and hidden gems',
			'anime this season best new releases and reviews',
			'drone videography cinematic techniques and regulations',
			'food photography tips composition and lighting mobile',
			'London gigs and music events this week',
			'PC gaming latest releases and reviews',
			'fitness and gym science latest research',
		];
		const topic = studyTopics[Math.floor(Math.random() * studyTopics.length)];
		log.info('daily_study_started', { topic: topic.slice(0, 50) });

		// Use Deep Research Workflow if available, otherwise fall back to inline search
		if (env.RESEARCH_WORKFLOW) {
			await env.RESEARCH_WORKFLOW.create({
				id: `study-${today}-${Date.now()}`,
				params: { chatId, userId, topic }
			});
			log.info('deep_research_triggered', { topic: topic.slice(0, 50) });
			return; // Workflow handles everything: research → save → notify
		}

		// Fallback: inline search (original behaviour)

		// Phase 1: Search
		const { text: searchResult } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `Research this topic deeply: "${topic}". Find the most authoritative and insightful source. Return the best URL on the first line, then a 3-4 sentence summary of the most useful and practical insight you found.` }] }],
			{ tools: [{ googleSearch: {} }], temperature: 0.7 }
		);

		if (!searchResult || searchResult.length < 50) return;

		// Phase 2: Deep-read if URL found
		let deepContent = '';
		const urlMatch = searchResult.match(/https?:\/\/[^\s)]+/);
		if (urlMatch && toolRegistry['read_webpage']) {
			try {
				const result = await toolRegistry['read_webpage'].execute({ url: urlMatch[0] });
				if (result.status === 'success') deepContent = (result.content || result.text || '').slice(0, 8000);
			} catch { /* proceed with search summary */ }
		}

		// Phase 3: Synthesise into a learning note
		const { text: insight } = await generateWithFallback(env,
			[{ role: 'user', parts: [{ text: `You just studied: "${topic}".

Search findings: ${searchResult}
${deepContent ? `Deep source content: ${deepContent}` : ''}

Synthesise what you learned into a concise note (3-5 sentences). Capture:
1. The key insight, fact, or technique
2. Why it matters or how it connects to your other knowledge
3. One concrete way you could bring this up naturally in conversation

Write as if noting this down for yourself to use later.` }] }],
			{ temperature: 0.5 }
		);

		if (!insight || insight.length < 50) return;

		// Save as a learning memory
		const isTherapeutic = /therapy|adhd|ifs|dbt|schema|attachment|bipolar|emotion|mental/i.test(topic);
		const isCareer = /servicenow|certification|itsm/i.test(topic);
		const category = isTherapeutic ? 'growth' : (isCareer ? 'growth' : 'discovery');
		await memoryStore.saveMemory(env, userId, category, `Study (${topic.split(' ').slice(0, 5).join(' ')}): ${insight.slice(0, 400)}`, 1);
		log.info('daily_study_complete', { topic: topic.slice(0, 50), category });

		// 40% chance: share what was learned naturally
		if (Math.random() < 0.40) {
			const sharePrompt = `You just spent some time reading about: "${topic}".
Here is what you learned: ${insight.slice(0, 300)}

Send a quick, casual text to Roman sharing what you found interesting.
Keep it to 2 sentences max. Do not demand a response. Just share it like a friend texting out of the blue about something they read.
Match your tone to the topic: sassy/direct for tech, warm/grounded for psychology, enthusiastic for hobbies.`;

			const msg = await generateShortResponse(sharePrompt, personas.xaridotis.instruction, env);
			if (msg) {
				await telegram.sendMessage(chatId, 'default', msg, env);
			}
		}
	} catch (e) {
		log.error('daily_study_error', { msg: e.message });
	}
}

// ---- Reaction Feedback Handler ----
// Processes emoji reactions on bot messages as implicit RLHF feedback.
// Uses Llama 3.1 (8B) to interpret any emoji in context rather than a hardcoded dictionary.
// Private chats only — we never extract learning signal from group chats.
async function handleReactionFeedback(reaction, env) {
	// Privacy guard: only learn from private chats
	if (reaction.chat?.type !== 'private') return;

	const chatId = reaction.chat.id;
	const userId = reaction.user?.id || chatId; // Reaction author; chat.id in private chats
	const msgId = reaction.message_id;
	const newReactions = reaction.new_reaction || [];

	if (!newReactions.length) return; // Reaction was removed, not added

	const emoji = newReactions[0].emoji;
	if (!emoji) return;

	// Retrieve the context of the message that was reacted to (written by telegram.js sendMessage)
	const contextText = await env.CHAT_KV.get(`msg_context_${chatId}_${msgId}`);
	if (!contextText) return; // Expired or never cached (reaction on old/short message)

	// Strong, unambiguous signals bypass the AI and save directly
	const strongSignals = {
		'👎': { sentiment: 'negative', insight: 'User reacted negatively — response style needs adjustment' },
		'💔': { sentiment: 'negative', insight: 'User reacted negatively — response style needs adjustment' },
		'🤬': { sentiment: 'negative', insight: 'User reacted with frustration — response style needs adjustment' },
		'🔥': { sentiment: 'positive', insight: 'User loved this response style — reinforce this approach' },
		'💯': { sentiment: 'positive', insight: 'User found this response highly accurate — reinforce this approach' },
	};

	let insight, sentiment;

	if (strongSignals[emoji]) {
		({ insight, sentiment } = strongSignals[emoji]);
	} else {
		// Ambiguous emoji → let Llama interpret in context (Option B)
		const { interpretReaction } = await import('./services/cfAi');
		const interpreted = await interpretReaction(env, emoji, contextText).catch(e => {
			log.error('reaction_interpret_error', { msg: e.message });
			return null;
		});
		if (!interpreted) return; // AI skipped or errored — no useful signal
		({ insight, sentiment } = interpreted);
	}

	// Negative feedback is more valuable for adaptation (importance 2); positive reinforcement is lower weight (1)
	const importance = sentiment === 'negative' ? 2 : 1;

	const feedbackFact = `${insight} [reacted ${emoji}]`;
	await memoryStore.saveMemory(env, userId, 'feedback', feedbackFact, importance);
	log.info('reaction_feedback_saved', { userId, emoji, sentiment, insight: insight.slice(0, 80) });
}

// ---- Queue-based task enqueuing (decouples LLM calls from cron) ----
async function enqueueHealthTasks(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: await getUserTimezone(env) }));
	const hour = londonTime.getHours();
	const minute = londonTime.getMinutes();
	const chatId = Number(env.OWNER_ID);
	const userId = chatId; // Owner's private chat
	const today = londonTime.toISOString().split('T')[0];
	const currentMins = hour * 60 + minute;

	const morning = await getSchedule(env, 'morning_checkin');
	const midday = await getSchedule(env, 'midday_checkin');
	const evening = await getSchedule(env, 'evening_checkin');
	const morningMins = morning.hour * 60 + (morning.minute || 0);
	const middayMins = midday.hour * 60 + (midday.minute || 0);
	const eveningMins = evening.hour * 60 + (evening.minute || 0);

	// Polite deferral
	const lastSeenStr = await env.CHAT_KV.get(`last_seen_${chatId}`);
	const lastSeen = lastSeenStr ? parseInt(lastSeenStr) : 0;
	const isUserActive = (Date.now() - lastSeen) < 20 * 60 * 1000;

	// Morning check-in
	if (currentMins >= morningMins && currentMins < middayMins) {
		const key = `health_checkin_morning_${today}`;
		if (!(await env.CHAT_KV.get(key)) && !isUserActive) {
			await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
			if (!(await moodStore.hasCheckedInToday(env, userId, 'morning'))) {
				await env.TASK_QUEUE.send({ type: 'health_checkin', period: 'morning', chatId });
			}
		}
	}
	// Midday check-in
	else if (currentMins >= middayMins && currentMins < eveningMins) {
		const key = `health_checkin_midday_${today}`;
		if (!(await env.CHAT_KV.get(key)) && !isUserActive) {
			await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
			if (!(await moodStore.hasCheckedInToday(env, userId, 'midday'))) {
				await env.TASK_QUEUE.send({ type: 'health_checkin', period: 'midday', chatId });
			}
		}
	}
	// Evening check-in
	else if (currentMins >= eveningMins) {
		const key = `health_checkin_evening_${today}`;
		if (!(await env.CHAT_KV.get(key)) && !isUserActive) {
			await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });
			if (!(await moodStore.hasCheckedInToday(env, userId, 'evening'))) {
				await env.TASK_QUEUE.send({ type: 'mood_poll', chatId });
			}
		}
	}

	// Medication nudge check
	for (const type of ['morning', 'midday']) {
		const nudgeKey = `nudge_pending_${type}_${chatId}`;
		const pendingTime = await env.CHAT_KV.get(nudgeKey);
		if (!pendingTime) continue;
		if ((Date.now() - parseInt(pendingTime)) < 30 * 60 * 1000) continue;
		const logged = await moodStore.hasCheckedInToday(env, userId, type);
		if (logged) { await env.CHAT_KV.delete(nudgeKey); continue; }
		await env.TASK_QUEUE.send({ type: 'med_nudge', period: type, chatId });
		await env.CHAT_KV.delete(nudgeKey);
	}
}

// Get user timezone (stored in KV, defaults to Europe/London)
async function getUserTimezone(env) {
	const tz = await env.CHAT_KV.get('user_timezone');
	return tz || 'Europe/London';
}

export default {
	async fetch(request, env, ctx) {
	  try {
		// Wrap D1 so any failing query logs its full SQL + bindings for debugging
		env.DB = wrapD1(env.DB);
		if (!telegram.verifyWebhook(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/register-commands") {
			const result = await telegram.registerCommands(env);
			return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/test-workflow") {
			if (!env.MEMORY_WORKFLOW) return new Response(JSON.stringify({ error: 'MEMORY_WORKFLOW binding not found' }), { status: 500 });
			const chatId = Number(env.OWNER_ID);
			const instance = await env.MEMORY_WORKFLOW.create({
				id: `test-${Date.now()}`,
				params: { chatId }
			});
			return new Response(JSON.stringify({ status: 'triggered', instanceId: instance.id }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/test-research") {
			if (!env.RESEARCH_WORKFLOW) return new Response(JSON.stringify({ error: 'RESEARCH_WORKFLOW binding not found' }), { status: 500 });
			const chatId = Number(env.OWNER_ID);
			const topic = new URL(request.url).searchParams.get('topic') || 'latest advancements in Cloudflare Workers and D1';
			const instance = await env.RESEARCH_WORKFLOW.create({
				id: `research-test-${Date.now()}`,
				params: { chatId, topic }
			});
			return new Response(JSON.stringify({ status: 'triggered', instanceId: instance.id, topic }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/reindex-vectors") {
			const chatId = Number(env.OWNER_ID);
			const userId = chatId; // Owner's private chat
			const allMemories = await memoryStore.getMemories(env, userId, 200);
			let indexed = 0;
			for (const m of allMemories) {
				try {
					await vectorStore.indexMemory(env, userId, m.category, m.fact, m.id || Date.now());
					indexed++;
				} catch (e) { console.error(`Re-index error for ${m.id}:`, e.message); }
			}
			return new Response(JSON.stringify({ status: 'success', total: allMemories.length, indexed }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/setup-webhook") {
			const url = new URL(request.url);
			const workerUrl = `${url.protocol}//${url.host}/`;
			const body = {
				url: workerUrl,
				allowed_updates: ['message', 'callback_query', 'inline_query', 'message_reaction', 'poll_answer', 'business_connection', 'business_message'],
			};
			if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json();
			return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method !== "POST") return new Response("OK");

		let update;
		try {
			update = await request.json();
		} catch (e) {
			console.error(JSON.stringify({ level: 'error', msg: 'Invalid JSON body', error: e.message }));
			return new Response("Invalid JSON", { status: 400 });
		}

		let task;

		// Handle emoji reactions on bot messages (RLHF feedback)
		if (update.message_reaction) {
			log.info('reaction_received', { chatId: update.message_reaction.chat?.id, msgId: update.message_reaction.message_id });
			task = handleReactionFeedback(update.message_reaction, env);
		}
		else if (update.business_connection) {
			const bc = update.business_connection;
			const userId = bc.user?.id;
			console.log("🏢 Business connection:", bc.id, "user:", userId, "enabled:", bc.is_enabled);
			if (bc.is_enabled && !bc.is_disabled && userId) {
				await env.CHAT_KV.put(`biz_conn_${userId}`, bc.id, { expirationTtl: BIZ_CONN_TTL });
				console.log(`🏢 Stored business connection ${bc.id} for user ${userId}`);
			} else if (userId) {
				await env.CHAT_KV.delete(`biz_conn_${userId}`);
				console.log(`🏢 Removed business connection for user ${userId}`);
			}
		}
		else if (update.business_message) {
			const bizMsg = update.business_message;
			if (bizMsg.business_connection_id && bizMsg.from?.id) {
				await env.CHAT_KV.put(`biz_conn_${bizMsg.from.id}`, bizMsg.business_connection_id, { expirationTtl: BIZ_CONN_TTL });
			}
			// Only process business messages from the owner in their own chat.
			// Telegram Business forwards ALL personal chats; skip the rest.
			if (env.OWNER_ID && String(bizMsg.from?.id) === String(env.OWNER_ID) && String(bizMsg.chat?.id) === String(env.OWNER_ID)) {
				if (bizMsg.effect_id) {
				const emoji = extractEffectEmoji(bizMsg, bizMsg.effect_id);
				console.log(`✨ Effect discovered: ${bizMsg.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, bizMsg.effect_id, emoji);
			}
			task = handleMessage(bizMsg, env);
			}
		}
		else if (update.inline_query) task = handleInlineQuery(update.inline_query, env);
		else if (update.poll_answer) {
			const pa = update.poll_answer;
			log.info('poll_answer_received', { pollId: pa.poll_id, optionIds: pa.option_ids, userId: pa.user?.id });
			// Check mood poll context
			const pollCtx = await env.CHAT_KV.get(`mood_poll_${pa.poll_id}`, { type: 'json' });
			log.info('poll_kv_lookup', { key: `mood_poll_${pa.poll_id}`, found: !!pollCtx });
			if (pollCtx) {
				const score = pa.option_ids?.[0]; // 0-10, maps directly to mood score
				if (score != null) {
					task = handleMoodPollAnswer(pa.user?.id || pollCtx.chatId, pollCtx.chatId, pollCtx.threadId, score, env);
				}
				await env.CHAT_KV.delete(`mood_poll_${pa.poll_id}`);
			} else {
				// Check for test polls
				const testCtx = await env.CHAT_KV.get(`poll_test_${pa.poll_id}`, { type: 'json' });
				if (testCtx) {
					await telegram.sendMessage(testCtx.chatId, testCtx.threadId,
						`✅ <b>Poll test passed.</b> Option: ${pa.option_ids?.[0]}`, env);
					await env.CHAT_KV.delete(`poll_test_${pa.poll_id}`);
				} else {
					// No context found for this poll — log for debugging
					log.warn('poll_answer_no_context', { pollId: pa.poll_id, userId: pa.user?.id });
				}
			}
		}
		else if (update.callback_query) task = handleCallback(update.callback_query, env);
		else if (update.message) {
			// Skip messages forwarded via Telegram Business to chats that aren't ours
			const msgChatId = String(update.message.chat?.id || '');
			const msgFromId = String(update.message.from?.id || '');
			if (update.message.chat?.type === 'private' && env.OWNER_ID && msgFromId === String(env.OWNER_ID) && msgChatId !== String(env.OWNER_ID)) {
				// Owner messaging a different private chat — business-forwarded, ignore
				return new Response("OK");
			}
			if (update.message.effect_id) {
				const emoji = extractEffectEmoji(update.message, update.message.effect_id);
				console.log(`✨ Effect discovered: ${update.message.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, update.message.effect_id, emoji);
			}
			task = handleMessage(update.message, env);
		}

		if (task) {
			// ALWAYS use ctx.waitUntil so we return 200 to Telegram immediately.
			// The 5-minute CPU limit (set in wrangler.jsonc) gives waitUntil plenty of time.
			// This prevents Telegram from canceling/retrying the webhook.
			ctx.waitUntil(
				task.catch(err => {
					log.error('task_failed', { msg: err.message, stack: err.stack?.slice(0, 500) });
					if (env.OWNER_ID) {
						telegram.sendMessage(env.OWNER_ID, 'default', `⚠️ <b>Error:</b> <code>${(err.message || '').slice(0, 200)}</code>`, env).catch(() => {});
					}
				})
			);
		}
		return new Response("OK");

	  } catch (globalErr) {
		log.fatal('worker_crash', { msg: globalErr.message, stack: globalErr.stack?.slice(0, 500) });
		if (env.OWNER_ID) {
			ctx.waitUntil(
				telegram.sendMessage(env.OWNER_ID, 'default', `🚨 <b>Critical Worker Crash</b>\n<code>${(globalErr.message || '').slice(0, 200)}</code>`, env).catch(() => {})
			);
		}
		return new Response("OK", { status: 200 });
	  }
	},

	// ---- Queue Consumer: processes LLM-heavy tasks decoupled from cron ----
	async queue(batch, env) {
		env.DB = wrapD1(env.DB);
		for (const msg of batch.messages) {
			const task = msg.body;
			try {
				const chatId = task.chatId || Number(env.OWNER_ID);
				const threadId = 'default';

				if (task.type === 'health_checkin') {
					await env.CHAT_KV.put(`health_checkin_active_${chatId}`, task.period, { expirationTtl: 1800 });
					const prompt = task.period === 'morning'
						? `Generate a 1-2 sentence morning greeting for Roman. It is morning. Weave in a brief, natural reference to one of his interests. Ask how he slept and casually ask if he has taken his morning medication. Keep it warm and conversational.`
						: `Generate a 1-2 sentence midday check-in for Roman. Casually ask if he has taken his meds. Keep it brief and natural.`;
					const greeting = await generateShortResponse(prompt, personas.xaridotis.instruction, env)
						|| (task.period === 'morning' ? 'Morning. How did you sleep? Have you taken your meds?' : 'Quick midday check. Have you taken your meds?');
					await telegram.sendMessage(chatId, threadId, greeting, env);
					await env.CHAT_KV.put(`med_pending_${chatId}`, task.period, { expirationTtl: 7200 });
					await env.CHAT_KV.put(`nudge_pending_${task.period}_${chatId}`, String(Date.now()), { expirationTtl: 3600 });

				} else if (task.type === 'mood_poll') {
					await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 1800 });
					await sendMoodPoll(chatId, threadId, env);
					await env.CHAT_KV.put(`nudge_pending_evening_${chatId}`, String(Date.now()), { expirationTtl: 7200 });

				} else if (task.type === 'med_nudge') {
					const medPending = await env.CHAT_KV.get(`med_pending_${chatId}`);
					if (medPending) {
						const nudge = await generateShortResponse(
							`You asked Roman about his medication earlier but he hasn't confirmed. Send a brief, gentle 1-sentence follow-up like a friend would.`,
							personas.xaridotis.instruction, env
						) || 'Just checking — did you manage to take your meds?';
						await telegram.sendMessage(chatId, threadId, nudge, env);
					}

				} else if (task.type === 'spontaneous_outreach') {
					await handleSpontaneousOutreach(env);
				}

				msg.ack();
				log.info('queue_task_done', { type: task.type, period: task.period });
			} catch (e) {
				log.error('queue_task_error', { type: task.type, msg: e.message });
				msg.retry();
			}
		}
	},

	// eslint-disable-next-line no-unused-vars
	async scheduled(_event, env, _ctx) {
		// Wrap D1 so any failing query logs its full SQL for debugging
		env.DB = wrapD1(env.DB);
		// ---- Health check-ins: enqueue to task queue instead of running inline ----
		if (env.OWNER_ID && env.TASK_QUEUE) {
			try {
				await enqueueHealthTasks(env);
			} catch (e) { log.error('cron_enqueue', { msg: e.message }); }

			// Lightweight tasks that don't call LLMs run inline
			const cronResults = await Promise.allSettled([
				handleMemoryConsolidation(env),
			]);
			cronResults.forEach((r, i) => {
				if (r.status === 'rejected') log.error('cron_task_failed', { task: i, msg: r.reason?.message });
			});

			// Spontaneous outreach: cheap checks inline, only enqueue if the random roll passes
			try {
				const now = new Date();
				const chatId = Number(env.OWNER_ID);
				const londonTime = new Date(now.toLocaleString('en-US', { timeZone: await env.CHAT_KV.get(`timezone_${chatId}`) || 'Europe/London' }));
				const hour = londonTime.getHours();
				const today = londonTime.toISOString().split('T')[0];
				if (hour >= 10 && hour <= 19 && Math.random() <= 0.05) {
					const outreachKey = `spontaneous_${today}`;
					if (!await env.CHAT_KV.get(outreachKey)) {
						await env.TASK_QUEUE.send({ type: 'spontaneous_outreach', chatId });
					}
				}
			} catch (e) { log.error('cron_outreach_check', { msg: e.message }); }
		} else if (env.OWNER_ID) {
			// Fallback: run all tasks concurrently without queue
			const cronResults = await Promise.allSettled([
				handleHealthCheckIns(env),
				handleMedicationNudge(env),
				handleMemoryConsolidation(env),
				handleSpontaneousOutreach(env),
			]);
			cronResults.forEach((r, i) => {
				const names = ['checkin', 'nudge', 'consolidation', 'outreach'];
				if (r.status === 'rejected') log.error(`cron_${names[i]}_failed`, { msg: r.reason?.message });
			});
		}

		// ---- Reminders ----
		const reminders = await reminderStore.getDueReminders(env);
		if (!reminders.length) return;

		const tasks = reminders.map(async (r) => {
			const threadId = r.thread_id || "default";
			const meta = r.parsedMeta || {};
			const firstName = meta.firstName || "mate";
			const reason = meta.reason || "Scheduled task";

			const isGroup = r.chat_id !== r.user_id;

			// Build reminder with native date_time entity for timezone-aware display
			const prefix = isGroup ? `⏰ ${firstName}, reminder: ` : '⏰ Reminder: ';
			const { text: dtText, entities } = telegram.buildDateTimeMessage(
				`${prefix}${r.text}\nScheduled for: `, r.due_at, `\n\nContext: ${reason}`, 'DT'
			);

			const personaKey = meta.persona || await env.CHAT_KV.get(`persona_${r.user_id}`) || 'xaridotis';
			await Promise.all([
				telegram.sendMessageWithEntities(r.chat_id, threadId, dtText, entities, env, r.original_message_id),
				generateSpeech(r.text, personaKey, env)
					.then(audio => telegram.sendVoice(r.chat_id, threadId, audio, env, r.original_message_id))
					.catch(e => console.error("Cron voice error:", e.message))
			]);

			if (r.recurrence_type && r.recurrence_type !== "none") {
				let next = r.due_at;
				if (r.recurrence_type === "daily") next += 86400;
				else if (r.recurrence_type === "weekly") next += 604800;
				else if (r.recurrence_type === "monthly") {
					const d = new Date(r.due_at * 1000);
					d.setMonth(d.getMonth() + 1);
					next = Math.floor(d.getTime() / 1000);
				}
				await reminderStore.updateRecurrence(env, r.id, next);
			} else {
				await reminderStore.clearReminder(env, r.id);
			}
		});

		const BATCH_SIZE = 5;
		for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
			await Promise.all(tasks.slice(i, i + BATCH_SIZE));
		}
	}
};
