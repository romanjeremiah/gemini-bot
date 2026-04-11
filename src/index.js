import { handleMessage, handleCallback } from './bot/handlers';
import { handleInlineQuery } from './bot/inlineHandler';
import * as reminderStore from './services/reminderStore';
import * as moodStore from './services/moodStore';
import * as memoryStore from './services/memoryStore';
import * as telegram from './lib/telegram';
import { generateSpeech } from './lib/tts';
import { generateShortResponse } from './lib/ai/gemini';
import { storeDiscoveredEffect } from './tools/effect';
import { personas, MENTAL_HEALTH_DIRECTIVE } from './config/personas';
import { ARCHITECTURE_SUMMARY } from './config/architecture';
import { getSchedule, matchesSchedule } from './config/schedules';
import { toolRegistry } from './tools/index';

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
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const hour = londonTime.getHours();
	const minute = londonTime.getMinutes();
	const chatId = Number(env.OWNER_ID);
	const threadId = 'default';

	// Only trigger at specific minutes to avoid duplicate sends (cron runs every minute)
	// Use KV to track if we already sent this check-in today
	const today = londonTime.toISOString().split('T')[0];

	// Load schedules from KV (with defaults fallback)
	const morning = await getSchedule(env, 'morning_checkin');
	const midday = await getSchedule(env, 'midday_checkin');
	const evening = await getSchedule(env, 'evening_checkin');

	// Morning check-in
	if (hour === morning.hour && minute >= morning.minute) {
		const key = `health_checkin_morning_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		// Set Nightfall as active persona for health check-in
		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'morning', { expirationTtl: 3600 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'morning');
		if (alreadyLogged) return;

		await telegram.sendMessage(chatId, threadId,
			`<b>Nightfall here.</b> Good morning.\n\nHow did you sleep? And have you taken your morning medication yet?`,
			env, null, {
				inline_keyboard: [[
					{ text: '💊 Taken', callback_data: 'mood_med_yes_morning' },
					{ text: '⏰ Not yet', callback_data: 'mood_med_no_morning' },
				]]
			});
		// Set nudge timer (checked every cron tick, fires after 30 min)
		await env.CHAT_KV.put(`nudge_pending_morning_${chatId}`, String(Date.now()), { expirationTtl: 3600 });
	}

	// Midday check-in
	else if (hour === midday.hour && minute >= midday.minute) {
		const key = `health_checkin_midday_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'midday', { expirationTtl: 3600 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'midday');
		if (alreadyLogged) return;

		await telegram.sendMessage(chatId, threadId,
			`<b>Nightfall checking in.</b> Quick midday pulse.\n\nHave you taken your ADHD and anxiety medication?`,
			env, null, {
				inline_keyboard: [[
					{ text: '✅ Both taken', callback_data: 'mood_med_yes_midday' },
					{ text: '💊 ADHD only', callback_data: 'mood_med_partial_midday' },
					{ text: '❌ Not yet', callback_data: 'mood_med_no_midday' },
				]]
			});
		// Set nudge timer
		await env.CHAT_KV.put(`nudge_pending_midday_${chatId}`, String(Date.now()), { expirationTtl: 3600 });
	}

	// Evening check-in
	else if (hour === evening.hour && minute >= evening.minute) {
		const key = `health_checkin_evening_${today}`;
		if (await env.CHAT_KV.get(key)) return;
		await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 });

		await env.CHAT_KV.put(`health_checkin_active_${chatId}`, 'evening', { expirationTtl: 7200 });

		const alreadyLogged = await moodStore.hasCheckedInToday(env, chatId, 'evening');
		if (alreadyLogged) return;

		// Evening: send formatted message with inline buttons
		await telegram.sendMessage(chatId, threadId,
			`<b>Nightfall here for your evening check-in.</b>\n\nWhere would you place yourself on the mood scale right now?\n\n🔴 <b>0-1: Severe Depression</b>\n<i>(Bleak, no movement, hopeless)</i>\n\n🟠 <b>2-3: Mild/Moderate</b>\n<i>(Struggle, anxious)</i>\n\n🟢 <b>4-6: Balanced</b>\n<i>(Good decisions, optimistic)</i>\n\n🟡 <b>7-8: Hypomania</b>\n<i>(Very productive, racing)</i>\n\n🔴 <b>9-10: Mania</b>\n<i>(Reckless, lost touch)</i>`,
			env, null, {
				inline_keyboard: [
					[{ text: '🔴 0-1', callback_data: 'mood_score_1' }, { text: '🟠 2-3', callback_data: 'mood_score_3' }],
					[{ text: '🟢 4-6', callback_data: 'mood_score_5' }],
					[{ text: '🟡 7-8', callback_data: 'mood_score_7' }, { text: '🔴 9-10', callback_data: 'mood_score_9' }]
				]
			});
		// Set nudge timer
		await env.CHAT_KV.put(`nudge_pending_evening_${chatId}`, String(Date.now()), { expirationTtl: 7200 });
	}
}

// ---- Medication Nudge ----
// If a check-in was sent but not responded to within 30 minutes, send a gentle nudge.
async function handleMedicationNudge(env) {
	const chatId = Number(env.OWNER_ID);
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
		const logged = await moodStore.hasCheckedInToday(env, chatId, type);
		if (logged) {
			await env.CHAT_KV.delete(nudgeKey);
			continue;
		}

		// Send the nudge and clear the flag
		const nudgeMessages = {
			morning: '<b>Gentle nudge</b> — have you taken your morning medication? A quick tap on the buttons above will log it.',
			midday: '<b>Quick reminder</b> — your ADHD medication works best when taken on time. Tap above to log it.',
			evening: '<b>Your evening check-in is still waiting.</b> Even a quick mood score helps track patterns over time.',
		};
		await telegram.sendMessage(chatId, threadId, nudgeMessages[type], env);
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
	const threadId = 'default';
	const today = londonTime.toISOString().split('T')[0];
	const reportKey = `weekly_report_${today}`;

	if (await env.CHAT_KV.get(reportKey)) return;
	await env.CHAT_KV.put(reportKey, '1', { expirationTtl: 86400 * 2 });

	try {
		// Pull the last 7 days of mood data
		const entries = await moodStore.getWeeklySummary(env, chatId);
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

		const report = await generateShortResponse(analysisPrompt, personas.nightfall.instruction, env);

		if (report) {
			await telegram.sendMessage(chatId, threadId,
				`<b>Your Weekly Mental Health Report</b>\n\n${report}`, env);

			// Save the weekly observation for long-term pattern tracking (Importance: 2)
			await memoryStore.saveMemory(env, chatId, 'insight', `Weekly Observation (${today}): ${report}`, 2, chatId);
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
	const today = londonTime.toISOString().split('T')[0];
	const nudgeKey = `accountability_nudge_${today}`;

	if (await env.CHAT_KV.get(nudgeKey)) return;
	await env.CHAT_KV.put(nudgeKey, '1', { expirationTtl: 86400 });

	try {
		const memories = await memoryStore.getRecentTherapeuticMemories(env, chatId, 7);
		if (!memories.length) return;

		// Fetch the most recent weekly insight for clinical context
		const recentInsights = await memoryStore.getMemoriesByCategory(env, chatId, 'insight', 1);
		const latestInsight = recentInsights.length > 0 ? recentInsights[0].fact : 'None';

		const prompt = `You are Nightfall.
Pending homework/coping strategies this week: ${JSON.stringify(memories)}
Most recent weekly observation: ${latestInsight}

Draft a gentle, proactive mid-week check-in.
1. Ask about their progress with the homework/coping strategies.
2. If (and ONLY if) it makes logical clinical sense, weave in the recent weekly observation as context for why they might be finding the homework easy or difficult right now.
3. If they have repeatedly avoided a task, gently hold up a mirror: "I notice we have paused on this a few times..." and ask what the biggest block is.

Keep it to 2-3 sentences. Be warm and curious, not demanding.`;

		const msg = await generateShortResponse(prompt, personas.nightfall.instruction, env);
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
	const month = londonTime.toISOString().split('-').slice(0, 2).join('-');
	const runKey = `rem_consolidation_${month}`;

	if (await env.CHAT_KV.get(runKey)) return;
	await env.CHAT_KV.put(runKey, '1', { expirationTtl: 86400 * 5 });

	try {
		await memoryStore.consolidateMemories(env, chatId);
		await telegram.sendMessage(chatId, 'default',
			'<i>Did some deep memory consolidation overnight. Your saved memories are organised and ready for the new month.</i>', env);
	} catch (e) {
		console.error('Consolidation error:', e.message);
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
	const today = londonTime.toISOString().split('T')[0];

	// Max one spontaneous message per day
	const outreachKey = `spontaneous_${today}`;
	if (await env.CHAT_KV.get(outreachKey)) return;
	await env.CHAT_KV.put(outreachKey, '1', { expirationTtl: 86400 });

	try {
		// Pull memories but filter out heavy clinical/trauma content
		const allMemories = await memoryStore.getMemories(env, chatId, 50);
		const casualMemories = allMemories.filter(m => !['pattern', 'schema', 'trigger', 'avoidance', 'insight'].includes(m.category));
		if (!casualMemories.length) return;

		const randomMemory = casualMemories[Math.floor(Math.random() * casualMemories.length)];

		// Use the active persona, not always Nightfall
		const personaKey = await env.CHAT_KV.get(`persona_${chatId}_default`) || 'tenon';
		const persona = personas[personaKey] || personas.tenon;

		const prompt = `You just thought of this: "${randomMemory.fact}" (type: ${randomMemory.category}).
${randomMemory.category === 'discovery' ? 'Present it as something you recently read and thought they would find interesting.' : 'Share a random observation or thought about it, like a friend texting out of the blue.'}
Keep it to 1-2 sentences. DO NOT ask a question. DO NOT offer help. DO NOT be a therapist. Just share it naturally.`;

		const msg = await generateShortResponse(prompt, persona.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', msg, env);
		}
	} catch (e) {
		console.error('Spontaneous outreach error:', e.message);
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
	const today = londonTime.toISOString().split('T')[0];
	const digestKey = `curiosity_digest_${today}`;

	if (await env.CHAT_KV.get(digestKey)) return;
	await env.CHAT_KV.put(digestKey, '1', { expirationTtl: 86400 * 2 });

	try {
		const { GoogleGenAI } = await import('@google/genai');
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const response = await ai.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: `Find the most interesting developments from THIS WEEK across these topics. Pick 3-4 of the most genuinely interesting items. For each write one punchy sentence explaining why it matters. Be selective not comprehensive. Skip anything boring.

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
			config: {
				temperature: 0.8,
				tools: [{ googleSearch: {} }],
			}
		});

		const digest = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('') || '';
		if (!digest || digest.length < 50) return;

		const personaKey = await env.CHAT_KV.get(`persona_${chatId}_default`) || 'tenon';
		const persona = personas[personaKey] || personas.tenon;

		const formatPrompt = `You are ${persona.name || 'Tenon'}. Rewrite this digest into a casual message as if texting a friend things you found interesting this week. Mix in your reactions and opinions. Keep your personality. No headers or bullet points. Natural flowing text, 4-6 sentences.

Raw digest:
${digest}`;

		const msg = await generateShortResponse(formatPrompt, persona.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', `<b>Things I found interesting this week</b>\n\n${msg}`, env);

			// Save the raw discoveries as a memory so they feed into spontaneous outreach and conversations
			await memoryStore.saveMemory(env, chatId, 'discovery', `Weekly research (${today}): ${digest.slice(0, 500)}`, 1, chatId);
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

		const { GoogleGenAI } = await import('@google/genai');
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const response = await ai.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: `Find ONE highly interesting, concrete piece of news or breakthrough from the last 7 days regarding: ${randomDomain}. Explain what it is and why someone interested in AI, photography, fitness, cooking, and anime would care about it. Keep it to 2-3 sentences.` }] }],
			config: { tools: [{ googleSearch: {} }], temperature: 0.7 }
		});

		const text = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('').trim();
		if (text && text.length > 30) {
			await memoryStore.saveMemory(env, chatId, 'discovery', `Research (${randomDomain.split('(')[0].trim()}): ${text}`, 1, chatId);
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
	const month = londonTime.toISOString().split('-').slice(0, 2).join('-');
	const key = `self_improve_${month}`;

	if (await env.CHAT_KV.get(key)) return;
	await env.CHAT_KV.put(key, '1', { expirationTtl: 86400 * 5 });

	try {
		const { GoogleGenAI } = await import('@google/genai');
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const response = await ai.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: `You are a senior AI engineer reviewing a Telegram chatbot's architecture. Your job is to suggest concrete, actionable improvements.

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
			config: {
				tools: [{ googleSearch: {} }],
				temperature: 0.7,
			}
		});

		const suggestions = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('') || '';
		if (!suggestions || suggestions.length < 100) return;

		// Save as a memory for future reference
		await memoryStore.saveMemory(env, chatId, 'discovery', `Self-improvement suggestions (${month}): ${suggestions.slice(0, 500)}`, 1, chatId);

		// Send to the user
		const formatPrompt = `Rewrite these technical suggestions into a casual, conversational message. You are Tenon sharing ideas with Roman about how to improve the bot. Keep your dry wit. Present each suggestion as something you noticed while doing some reading, not as a formal report. 3-4 short paragraphs.

Raw suggestions:
${suggestions}`;

		const msg = await generateShortResponse(formatPrompt, personas.tenon.instruction, env);
		if (msg) {
			await telegram.sendMessage(chatId, 'default', `<b>Monthly self-assessment</b>\n\n${msg}`, env);
		}
	} catch (e) {
		console.error('Self-improvement error:', e.message);
	}
}

// ---- Autonomous Architecture Evolution (Weekly Deep Search) ----
// Runs once a week. Searches one technology deeply, reads actual docs via read_webpage, suggests PRs.
async function handleArchitectureEvolution(env) {
	const now = new Date();
	const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
	const schedule = await getSchedule(env, 'architecture_evolution');

	if (schedule.day !== undefined && londonTime.getDay() !== schedule.day) return;
	if (schedule.hour !== undefined && londonTime.getHours() !== schedule.hour) return;

	const chatId = Number(env.OWNER_ID);
	const today = londonTime.toISOString().split('T')[0];
	const currentKey = `auto_architect_${today}`;

	if (await env.CHAT_KV.get(currentKey)) return;
	await env.CHAT_KV.put(currentKey, '1', { expirationTtl: 86400 * 2 });

	try {
		const { GoogleGenAI } = await import('@google/genai');
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const technologies = [
			'Cloudflare Workers D1 Vectorize latest updates',
			'Telegram Bot API recent changes new methods',
			'Google Gemini API Node SDK new features',
			'Cloudflare Workers performance best practices',
		];
		const randomTech = technologies[Math.floor(Math.random() * technologies.length)];

		// Phase 1: Search for the latest docs/updates
		const searchResponse = await ai.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: `Search for the latest updates or changes for: ${randomTech}. Find the most relevant official documentation URL. Return the URL on the first line, then a 2-sentence summary of what changed.` }] }],
			config: { tools: [{ googleSearch: {} }], temperature: 0.5 }
		});

		const searchText = searchResponse.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('').trim() || '';
		if (!searchText || searchText.length < 30) return;

		// Phase 2: Deep-read the URL via read_webpage tool
		let deepContent = '';
		const urlMatch = searchText.match(/https?:\/\/[^\s)]+/);
		if (urlMatch && toolRegistry['read_webpage']) {
			try {
				const result = await toolRegistry['read_webpage'].execute({ url: urlMatch[0] });
				if (result.status === 'success') deepContent = `\n\nDOCUMENTATION FROM ${urlMatch[0]}:\n${result.content.slice(0, 8000)}`;
			} catch { /* proceed with search summary only */ }
		}

		// Phase 3: Compare against architecture and draft PR
		const prResponse = await ai.models.generateContent({
			model: 'gemini-3.1-pro-preview',
			contents: [{ role: 'user', parts: [{ text: `You are a Principal Architect reviewing a Telegram bot.

SEARCH FINDINGS:
${searchText}
${deepContent}

CURRENT ARCHITECTURE:
${ARCHITECTURE_SUMMARY}

Compare findings against the architecture. If you find a concrete improvement NOT already implemented, draft a Pull Request:
1. What to change (specific file paths)
2. Why it matters
3. A code sketch of the key change

TRUSTED SOURCES: Ensure all research relies on open, trusted sources. For health/medical topics use NHS, NICE, APA, WHO, BAP. For technical topics use official documentation. Follow modern software engineering best practices.

If no improvement is needed, respond with exactly: NO_PR_NEEDED
Keep it under 500 words. End with: "Awaiting your manual review."` }] }],
			config: { temperature: 0.5 }
		});

		const prText = prResponse.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('').trim() || '';

		if (prText && !prText.includes('NO_PR_NEEDED') && prText.length > 50) {
			await telegram.sendMessage(chatId, 'default', `<b>Architecture Deep Search</b>\n\n${prText}`, env, null, {
				inline_keyboard: [[
					{ text: '💬 Discuss', callback_data: 'discuss_pr' },
					{ text: '❌ Dismiss', callback_data: 'action_dismiss_pr' }
				]]
			});
			await memoryStore.saveMemory(env, chatId, 'discovery', `Architecture PR (${randomTech}): ${prText.slice(0, 300)}`, 1, chatId);
		}
	} catch (e) {
		console.error('Architecture evolution error:', e.message);
	}
}

export default {
	async fetch(request, env, ctx) {
		if (!telegram.verifyWebhook(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/register-commands") {
			const result = await telegram.registerCommands(env);
			return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method === "GET" && new URL(request.url).pathname === "/setup-webhook") {
			const url = new URL(request.url);
			const workerUrl = `${url.protocol}//${url.host}/`;
			const params = new URLSearchParams({ url: workerUrl });
			if (env.WEBHOOK_SECRET) params.set("secret_token", env.WEBHOOK_SECRET);
			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?${params}`);
			const data = await res.json();
			return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } });
		}

		if (request.method !== "POST") return new Response("OK");
		const update = await request.json();

		let task;

		if (update.business_connection) {
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
			if (bizMsg.effect_id) {
				const emoji = extractEffectEmoji(bizMsg, bizMsg.effect_id);
				console.log(`✨ Effect discovered: ${bizMsg.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, bizMsg.effect_id, emoji);
			}
			task = handleMessage(bizMsg, env);
		}
		else if (update.inline_query) task = handleInlineQuery(update.inline_query, env);
		else if (update.callback_query) task = handleCallback(update.callback_query, env);
		else if (update.message) {
			if (update.message.effect_id) {
				const emoji = extractEffectEmoji(update.message, update.message.effect_id);
				console.log(`✨ Effect discovered: ${update.message.effect_id} emoji: ${emoji}`);
				await storeDiscoveredEffect(env, update.message.effect_id, emoji);
			}
			task = handleMessage(update.message, env);
		}

		if (task) {
			// Instantly acknowledge Telegram to prevent 60-second webhook timeout retries.
			// Heavy operations (/architect, image gen, long AI responses) run in the background.
			ctx.waitUntil(task.catch(e => console.error('Background task error:', e.message)));
		}
		return new Response("OK");
	},

	// eslint-disable-next-line no-unused-vars
	async scheduled(_event, env, _ctx) {
		// ---- Health check-ins (owner only, Nightfall persona) ----
		if (env.OWNER_ID) {
			try { await handleHealthCheckIns(env); } catch (e) { console.error('Cron check-in error:', e.message); }
			try { await handleMedicationNudge(env); } catch (e) { console.error('Cron nudge error:', e.message); }
			try { await handleWeeklyReport(env); } catch (e) { console.error('Cron report error:', e.message); }
			try { await handleAccountabilityNudge(env); } catch (e) { console.error('Cron accountability error:', e.message); }
			try { await handleMemoryConsolidation(env); } catch (e) { console.error('Cron consolidation error:', e.message); }
			try { await handleSpontaneousOutreach(env); } catch (e) { console.error('Cron outreach error:', e.message); }
			try { await handleCuriosityDigest(env); } catch (e) { console.error('Cron digest error:', e.message); }
			try { await handleAutonomousResearch(env); } catch (e) { console.error('Cron research error:', e.message); }
			try { await handleSelfImprovement(env); } catch (e) { console.error('Cron self-improve error:', e.message); }
			try { await handleArchitectureEvolution(env); } catch (e) { console.error('Cron architecture error:', e.message); }
		}

		// ---- Reminders ----
		const reminders = await reminderStore.getDueReminders(env);
		if (!reminders.length) return;

		const tasks = reminders.map(async (r) => {
			const threadId = r.thread_id || "default";
			const meta = r.parsedMeta || {};
			const firstName = meta.firstName || "mate";
			const reason = meta.reason || "Scheduled task";

			const isGroup = r.recipient_chat_id !== r.creator_chat_id;
			// noinspection HtmlUnknownAttribute
			let reminderText = `⏰ <b>Reminder:</b> ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;
			if (isGroup) {
				reminderText = `⏰ <b>${firstName}</b>, reminder: ${r.text}\n\n<blockquote expandable>Context: ${reason}</blockquote>`;
			}

			const personaKey = meta.persona || await env.CHAT_KV.get(`persona_${r.creator_chat_id}`) || "tenon";
			await Promise.all([
				telegram.sendMessage(r.recipient_chat_id, threadId, reminderText, env, r.original_message_id),
				generateSpeech(r.text, personaKey, env)
					.then(audio => telegram.sendVoice(r.recipient_chat_id, threadId, audio, env, r.original_message_id))
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
