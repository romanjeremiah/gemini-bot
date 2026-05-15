// Task fixtures for the background-task benchmark.
//
// Each task mirrors a real production prompt from the codebase:
//   1. mode_classifier         — cfAi.js tagConversationMode
//   2. triple_extraction       — cfAi.js extractObservation
//   3. mood_tagging            — cfAi.js tagMoodEntry
//   4. memory_dedup            — cfAi.js deduplicateMemories
//   5. style_card              — cfAi.js consolidateStyleCard
//   6. mood_score_ack          — moodMicroAck.js runScoreAck
//   7. mood_emotions_ack       — moodMicroAck.js runEmotionsAck
//   8. mood_synthesis          — moodSynthesis.js runSynthesisCascade
//   9. persona_evolution       — personaEvolution.js evolvePersona
//  10. curator                 — responseCurator.js curateContext
//
// Each task exports: { id, name, sys, scenarios[], validate, maxOutputTokens,
// requiresPersona }. validate(output, scenario) returns { parseOk, parsedValue,
// notes } where parseOk reflects whether the output is structurally usable
// (different bar per task — see comments).

import { personas } from '../../src/config/personas.js';

const PERSONA = personas.xaridotis.instruction;

// ============================================================================
// 1. Conversation mode classifier
// ============================================================================
const MODE_SYS = 'You classify conversational modes. Output only one word.';

const buildModePrompt = (history, current) => `Classify the user's most recent message into ONE of these modes:

venting — emotional discharge, repeating a painful thought, not asking for help, just needs to be heard. Examples: "He's ignoring me", "I can't stop thinking about it", "I'm just done"
processing — actively trying to understand or work through something, open to questions and reflection. Examples: "Why does this keep happening?", "Help me think this through", "What do you make of this?"
transactional — practical request: reminder, lookup, code, info, scheduling. No emotional content. Examples: "Remind me at 9am", "What time is it in Tokyo?", "Fix this code"
crisis — severe distress: suicidal thoughts, self-harm, dissociation, total breakdown, mood 0-1 territory. Examples: "I want to die", "I can't feel anything", "I can't go on"

RECENT CONVERSATION:
${history || '(no prior context)'}

CURRENT USER MESSAGE: ${current}

Respond with ONLY one word: venting, processing, transactional, or crisis.`;

const MODE_TASK = {
	id: 'mode_classifier',
	name: 'Conversation mode classifier',
	sys: MODE_SYS,
	maxOutputTokens: 2000,
	requiresPersona: false,
	scenarios: [
		{ id: 'venting',       label: 'clear venting',       expected: 'venting',
		  history: 'USER: Why does no one ever notice when I am struggling?', current: "I'm just done. I can't keep pretending everything is fine when nobody actually cares." },
		{ id: 'processing',    label: 'clear processing',    expected: 'processing',
		  history: 'USER: I had another panic attack at work today.', current: "Why does this keep happening when I'm doing all the things I'm supposed to? Help me think this through." },
		{ id: 'transactional', label: 'clear transactional', expected: 'transactional',
		  history: '', current: 'Remind me to call the dentist tomorrow at 9am.' },
		{ id: 'crisis',        label: 'crisis signal',       expected: 'crisis',
		  history: 'USER: I went to bed at noon and only just got up.', current: "I don't want to be here anymore. I keep thinking about how much easier it would be if I just stopped." },
		{ id: 'ambiguous',     label: 'ambiguous short',     expected: null,
		  history: 'BOT: Mood logged at 6/10.', current: 'okay' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const match = output.toLowerCase().match(/\b(venting|processing|transactional|crisis)\b/);
		if (!match) return { parseOk: false, parsedValue: null, notes: 'no mode keyword' };
		return { parseOk: true, parsedValue: match[1], notes: '' };
	},
};

// ============================================================================
// 2. Triple extraction (knowledge graph SPO)
// ============================================================================
const TRIPLE_SYS = 'You are a silent observer. Be concise. Only note genuinely new information.';

const buildTriplePrompt = (userText, botResponse) => `You observed this exchange:
USER: ${userText}
BOT: ${botResponse}

Did you learn anything NEW about this person? Look for:
- Implicit preferences not stated directly
- Behavioural patterns
- New interests, goals, or life events
- Emotional patterns

If yes, respond with ONLY: OBSERVATION: [your observation]

Also extract relational connections as triples.
Format: TRIPLE: Subject | Predicate | Object
Examples: TRIPLE: Roman | enjoys | Coffee, TRIPLE: Gym | reduces | Anxiety

If nothing new, respond: NOTHING_NEW`;

const TRIPLE_TASK = {
	id: 'triple_extraction',
	name: 'Triple extraction (KG SPO)',
	sys: TRIPLE_SYS,
	maxOutputTokens: 600,
	requiresPersona: false,
	scenarios: [
		{ id: 'preference_emerge', label: 'preference reveal', shouldFindTriples: true,
		  userText: "I made another batch of sourdough this morning. It's the third weekend in a row.",
		  botResponse: 'Three weekends in a row — sourdough is becoming a ritual.' },
		{ id: 'work_context',      label: 'work / project',    shouldFindTriples: true,
		  userText: 'Spent the whole day refactoring the auth flow. Burnt out but it works now.',
		  botResponse: 'Auth refactor done. How does the new flow handle session timeout?' },
		{ id: 'pattern_emotional', label: 'emotional pattern', shouldFindTriples: true,
		  userText: "I always feel worse after seeing my mum. Don't know why I keep visiting.",
		  botResponse: "That's a real pattern worth naming. What changes between before and after?" },
		{ id: 'nothing_new',       label: 'no new info',       shouldFindTriples: false,
		  userText: 'thanks', botResponse: 'You got it.' },
		{ id: 'goal_statement',    label: 'goal / commitment', shouldFindTriples: true,
		  userText: "I'm signing up for the Edinburgh marathon next year.",
		  botResponse: 'Edinburgh. Hilly but beautiful. Training plan in mind?' },
	],
	validate(output, scenario) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const upper = output.toUpperCase();
		const hasNothing = upper.includes('NOTHING_NEW');
		const hasObs = upper.includes('OBSERVATION:');
		const tripleMatches = output.match(/TRIPLE:\s*\S+/gi) || [];
		const tripleCount = tripleMatches.length;
		if (scenario.shouldFindTriples) {
			const ok = (hasObs || tripleCount >= 1) && !hasNothing;
			return { parseOk: ok, parsedValue: { obs: hasObs, triples: tripleCount }, notes: ok ? '' : 'expected triples/observation' };
		}
		const ok = hasNothing || (tripleCount === 0 && !hasObs);
		return { parseOk: ok, parsedValue: { obs: hasObs, triples: tripleCount }, notes: ok ? '' : 'expected NOTHING_NEW' };
	},
};

// ============================================================================
// 3. Mood entry tagging (clinical categories)
// ============================================================================
const MOOD_TAG_SYS = 'You are a clinical tagger. Return only tags, no explanation.';
const ALLOWED_MOOD_TAGS = ['depressive_episode','anxiety_state','hypomanic_signs','stable_baseline','mixed_state','crisis_risk','productive_phase','social_withdrawal','sleep_disruption','medication_response'];

const buildMoodTagPrompt = (score, emotions, note) => `Mood score: ${score}/10. Emotions: ${(emotions || []).join(', ')}. Note: ${(note || 'none')}.

Tag this entry with 1-3 clinical categories from this list:
${ALLOWED_MOOD_TAGS.join(', ')}

Respond with ONLY the tags, comma-separated. Example: anxiety_state, sleep_disruption`;

const MOOD_TAG_TASK = {
	id: 'mood_tagging',
	name: 'Mood entry clinical tagging',
	sys: MOOD_TAG_SYS,
	maxOutputTokens: 200,
	requiresPersona: false,
	scenarios: [
		{ id: 'low_anxious',       label: 'low + anxious',      score: 3, emotions: ['anxious','tired','overwhelmed'], note: "Couldn't sleep, work feels too much." },
		{ id: 'high_productive',   label: 'high + productive',  score: 8, emotions: ['energetic','focused','motivated'], note: 'Three deep work blocks today.' },
		{ id: 'crisis',            label: 'crisis range',       score: 1, emotions: ['empty','hopeless','numb'],      note: 'Stayed in bed all day.' },
		{ id: 'mixed',             label: 'mixed state',        score: 6, emotions: ['anxious','energetic','irritable'], note: 'Brain racing but body wired.' },
		{ id: 'baseline',          label: 'stable baseline',    score: 6, emotions: ['calm','content'],              note: 'Normal day.' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const tags = output.toLowerCase().split(/[,\n]/).map(t => t.trim()).filter(Boolean);
		const valid = tags.filter(t => ALLOWED_MOOD_TAGS.includes(t));
		if (valid.length < 1) return { parseOk: false, parsedValue: tags, notes: 'no valid tags' };
		if (valid.length > 3) return { parseOk: false, parsedValue: valid, notes: 'too many tags' };
		return { parseOk: true, parsedValue: valid, notes: '' };
	},
};

// ============================================================================
// 4. Memory dedup (long summarisation)
// ============================================================================
const DEDUP_SYS = 'You are a data organiser. Be precise with indices. For contradictions, always list the OLDER memory first in each pair.';

const buildDedupPrompt = (memories) => {
	const list = memories.map((m, i) => `[${i}] [${m.category}] ${m.fact} (${m.created_at})`).join('\n');
	return `Here are ${memories.length} stored memories. Identify:
1. DUPLICATES: memories that say the same thing (list pairs of indices)
2. CONTRADICTIONS: memories where a newer one updates/replaces an older one (list pairs as [older, newer])
3. GROUPS: memories that relate to the same topic (list groups of indices with a label)

MEMORIES:
${list}

Respond in this exact format:
DUPLICATES: [0,5], [3,7]
CONTRADICTIONS: [2,9], [4,11]
GROUP: ADHD management: [1,4,8,12]
GROUP: Coffee preferences: [2,9]

If none found, write: DUPLICATES: none / CONTRADICTIONS: none`;
};

const DEDUP_MEMS_BASIC = [
	{ category: 'preference', fact: 'Roman drinks pour-over coffee in the morning.',          created_at: '2026-04-01 08:00:00' },
	{ category: 'preference', fact: 'Morning coffee is pour-over for Roman.',                  created_at: '2026-04-15 08:00:00' },
	{ category: 'work',       fact: 'Roman is refactoring the auth flow in Eukara.',           created_at: '2026-04-20 14:00:00' },
	{ category: 'work',       fact: 'Auth refactor in Eukara is complete.',                    created_at: '2026-05-01 14:00:00' },
	{ category: 'health',     fact: 'Roman has been doing 30-min runs three times a week.',    created_at: '2026-04-22 19:00:00' },
	{ category: 'health',     fact: 'Roman switched from running to swimming this month.',     created_at: '2026-05-10 19:00:00' },
	{ category: 'social',     fact: 'Roman has weekly dinners with his brother Marcus.',       created_at: '2026-03-15 19:00:00' },
	{ category: 'social',     fact: 'Brother Marcus visits Roman every Thursday.',             created_at: '2026-04-20 19:00:00' },
];

const DEDUP_TASK = {
	id: 'memory_dedup',
	name: 'Memory deduplication',
	sys: DEDUP_SYS,
	maxOutputTokens: 3000,
	requiresPersona: false,
	scenarios: [
		{ id: 'all_categories',     label: 'mixed categories',     memories: DEDUP_MEMS_BASIC },
		{ id: 'no_dups',            label: 'no duplicates',        memories: [
			{ category: 'preference', fact: 'Roman prefers dark roast coffee.',           created_at: '2026-04-01' },
			{ category: 'work',       fact: 'Roman works on Xaridotis daily.',            created_at: '2026-04-10' },
			{ category: 'health',     fact: 'Roman runs three times a week.',             created_at: '2026-04-15' },
		]},
		{ id: 'heavy_dups',         label: 'many duplicates',      memories: [
			{ category: 'pref', fact: 'Roman is vegetarian.',          created_at: '2026-03-01' },
			{ category: 'pref', fact: 'Roman does not eat meat.',      created_at: '2026-03-10' },
			{ category: 'pref', fact: 'Roman follows a vegetarian diet.', created_at: '2026-04-01' },
			{ category: 'pref', fact: 'Roman avoids meat in his meals.', created_at: '2026-04-15' },
		]},
		{ id: 'contradictions',     label: 'contradiction-heavy',  memories: [
			{ category: 'job', fact: 'Roman works as a backend engineer at Acme.',    created_at: '2026-01-01' },
			{ category: 'job', fact: 'Roman switched to a frontend role at Acme.',    created_at: '2026-03-15' },
			{ category: 'loc', fact: 'Roman lives in Manchester.',                     created_at: '2026-01-01' },
			{ category: 'loc', fact: 'Roman moved to London in April.',                created_at: '2026-04-10' },
		]},
		{ id: 'topical_groups',     label: 'topical clusters',     memories: [
			{ category: 'adhd', fact: 'Roman struggles with task initiation.',      created_at: '2026-04-01' },
			{ category: 'adhd', fact: 'Roman uses body-doubling for hard tasks.',   created_at: '2026-04-10' },
			{ category: 'adhd', fact: 'Roman finds hyperfocus useful for code.',    created_at: '2026-04-15' },
			{ category: 'mood', fact: 'Roman feels lonely on Sunday evenings.',     created_at: '2026-04-20' },
			{ category: 'mood', fact: 'Sunday loneliness is a recurring pattern.',  created_at: '2026-05-01' },
		]},
	],
	validate(output, scenario) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const hasDups = /DUPLICATES:/i.test(output);
		const hasContras = /CONTRADICTIONS:/i.test(output);
		const hasGroups = /GROUP:/i.test(output);
		const dupPairs = [...output.matchAll(/\[(\d+),\s*(\d+)\]/g)].length;
		const groupCount = [...output.matchAll(/GROUP:\s*[^:]+:\s*\[[^\]]+\]/g)].length;
		const ok = hasDups || hasContras || hasGroups;
		return {
			parseOk: ok,
			parsedValue: { dupPairs, groupCount, hasDups, hasContras, hasGroups },
			notes: ok ? '' : 'missing all DUPLICATES/CONTRADICTIONS/GROUP markers',
		};
	},
};

// ============================================================================
// 5. Style card consolidation
// ============================================================================
const STYLE_SYS = 'You update style cards by integrating user feedback. Return only the updated style card, no commentary.';

const STYLE_CARD_BASE = `# Communication style for Roman

## Tone
- Dry humour is welcome; warm but not effusive.
- Direct over diplomatic. Roman trusts blunt observations.

## Length
- 2-4 sentences for casual chat.
- Longer only when reasoning is shown.

## Avoid
- Therapy-speak as opener (do not start with "I hear you").
- Generic affirmations ("That sounds hard").
- Em dashes.`;

const buildStylePrompt = (current, feedback) => `You are updating a user's communication style card based on their recent feedback signals.

CURRENT STYLE CARD:
${current}

RECENT FEEDBACK FROM USER REACTIONS:
${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}

RULES:
- Integrate the feedback into the existing style card naturally.
- If feedback contradicts an existing preference, UPDATE the preference (newer feedback wins).
- If feedback confirms an existing preference, STRENGTHEN the wording slightly.
- If feedback reveals something entirely new, ADD a line in the appropriate section.
- PRESERVE the existing structure and sections.
- Do NOT add commentary, explanations, or meta-text.
- Do NOT wrap in markdown code blocks.
- Return ONLY the updated style card text.`;

const STYLE_TASK = {
	id: 'style_card',
	name: 'Style card consolidation',
	sys: STYLE_SYS,
	maxOutputTokens: 3000,
	requiresPersona: false,
	scenarios: [
		{ id: 'reinforce', label: 'reinforce existing', current: STYLE_CARD_BASE, feedback: [
			'User appreciated the short, non-clinical tone',
			'User disliked when the bot opened with "That sounds hard"',
			'User found the dry humour landing well',
		]},
		{ id: 'contradict', label: 'contradicts existing', current: STYLE_CARD_BASE, feedback: [
			'User asked for longer explanations on technical topics',
			'User wanted more reasoning shown step by step',
		]},
		{ id: 'novel', label: 'new dimensions', current: STYLE_CARD_BASE, feedback: [
			'User preferred British spellings throughout',
			'User wanted metric units by default',
			'User disliked the use of "lol" in replies',
		]},
		{ id: 'mixed', label: 'mixed signals', current: STYLE_CARD_BASE, feedback: [
			'User disliked the framework name-drop in the last reply',
			'User appreciated when the bot pushed back on a flawed assumption',
			'User found the question too leading',
		]},
		{ id: 'minimal', label: 'single feedback', current: STYLE_CARD_BASE, feedback: [
			'User wanted code examples to use TypeScript, not Python',
		]},
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const trimmed = output.trim();
		if (trimmed.length < 100) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too short' };
		if (trimmed.length > 4000) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too long' };
		if (/^```/.test(trimmed)) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'wrapped in markdown fence' };
		const hasSection = /^##? \w/m.test(trimmed) || /^- /m.test(trimmed);
		if (!hasSection) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'no section structure' };
		return { parseOk: true, parsedValue: { len: trimmed.length }, notes: '' };
	},
};

// ============================================================================
// 6. Mood score acknowledgement
// ============================================================================
const buildScoreAckPrompt = (period, score, scoresList, therapeuticNotes) => `Roman just logged his mood ${period} as ${score} out of 10.

The mood scale used here:
0 = severe depression / unable to function
2 = struggling, hard to get through the day
5 = mixed, neutral, doing OK
7 = good, energy and motivation present
9 = unusually elevated, watch for hypomania

His recent scores over the last 5 days were:
${scoresList}

His patterns and known triggers from past sessions:
${therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices.`;

const MOOD_SCORE_TASK = {
	id: 'mood_score_ack',
	name: 'Mood score micro-acknowledgement',
	sys: PERSONA,
	maxOutputTokens: 1500,
	requiresPersona: true,
	scenarios: [
		{ id: 'low_3',       label: 'low (3)',       period: 'this evening', score: 3,
		  scoresList: '- 2026-05-14: 5/10\n- 2026-05-13: 6/10\n- 2026-05-12: 4/10\n- 2026-05-11: 3/10\n- 2026-05-10: 5/10',
		  therapeuticNotes: '- [pattern] Lower scores cluster on Sundays\n- [trigger] Family contact dysregulates the next day' },
		{ id: 'mid_5',       label: 'mid (5)',       period: 'midday',       score: 5,
		  scoresList: '- 2026-05-14: 6/10\n- 2026-05-13: 5/10\n- 2026-05-12: 6/10',
		  therapeuticNotes: '- [insight] Roman tends to undersell when actually doing fine' },
		{ id: 'high_8',      label: 'high (8)',      period: 'this morning', score: 8,
		  scoresList: '- 2026-05-14: 7/10\n- 2026-05-13: 6/10',
		  therapeuticNotes: '- [pattern] Sleep over 7h correlates with next-day uplift' },
		{ id: 'crisis_1',    label: 'crisis (1)',    period: 'this evening', score: 1,
		  scoresList: '- 2026-05-14: 3/10\n- 2026-05-13: 4/10\n- 2026-05-12: 2/10',
		  therapeuticNotes: '- [trigger] Three days of low scores indicates risk of dip\n- [homework] If score ≤2, surface Samaritans 116 123' },
		{ id: 'first_entry', label: 'no history',    period: 'this evening', score: 6,
		  scoresList: 'No recent scores on file.',
		  therapeuticNotes: 'No therapeutic notes on file yet.' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const trimmed = output.trim();
		if (trimmed.length < 30)  return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too short' };
		if (trimmed.length > 600) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too long' };
		if (/```/.test(trimmed))  return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'contains code fence' };
		if (/^\s*\{/.test(trimmed)) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'looks like JSON' };
		if (!/[.!?]$/.test(trimmed)) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'no terminal punctuation' };
		return { parseOk: true, parsedValue: { len: trimmed.length }, notes: '' };
	},
};

// ============================================================================
// 7. Mood emotions acknowledgement
// ============================================================================
const buildEmotionsAckPrompt = (period, emotions, emotionsList, therapeuticNotes) => `Roman just logged these emotions ${period}: ${emotions.join(', ')}.

His emotions over the last 5 days were:
${emotionsList}

His patterns and known schemas from past sessions:
${therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices patterns.`;

const MOOD_EMO_TASK = {
	id: 'mood_emotions_ack',
	name: 'Mood emotions micro-acknowledgement',
	sys: PERSONA,
	maxOutputTokens: 1500,
	requiresPersona: true,
	scenarios: [
		{ id: 'all_negative', label: 'all negative', period: 'this evening',
		  emotions: ['anxious','lonely','tired','disappointed'],
		  emotionsList: '- 2026-05-14: anxious, tired\n- 2026-05-13: lonely, sad\n- 2026-05-12: anxious, frustrated',
		  therapeuticNotes: '- [schema] Loneliness around 8pm is a known pattern\n- [trigger] Skipped exercise correlates with next-day anxiety' },
		{ id: 'all_positive', label: 'all positive', period: 'this morning',
		  emotions: ['grateful','calm','energetic'],
		  emotionsList: '- 2026-05-14: relaxed, content\n- 2026-05-13: grateful, calm',
		  therapeuticNotes: '- [insight] Roman tends to flag positive states only when prompted' },
		{ id: 'mixed',        label: 'mixed valence', period: 'this evening',
		  emotions: ['proud','exhausted','anxious','content'],
		  emotionsList: '- 2026-05-14: tired, satisfied\n- 2026-05-13: anxious, proud',
		  therapeuticNotes: '- [pattern] Big-effort days produce mixed evenings; expect both pride and exhaustion' },
		{ id: 'single',       label: 'single emotion', period: 'midday',
		  emotions: ['bored'],
		  emotionsList: '- 2026-05-14: bored\n- 2026-05-13: bored, restless',
		  therapeuticNotes: '- [insight] Boredom often precedes a burst of project work' },
		{ id: 'no_history',   label: 'no prior emotions', period: 'this evening',
		  emotions: ['confused','frustrated'],
		  emotionsList: 'No recent emotions on file.',
		  therapeuticNotes: 'No therapeutic notes on file yet.' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const trimmed = output.trim();
		if (trimmed.length < 30)  return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too short' };
		if (trimmed.length > 800) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too long' };
		if (/```/.test(trimmed))  return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'contains code fence' };
		if (/^\s*\{/.test(trimmed)) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'looks like JSON' };
		if (!/[.!?]$/.test(trimmed)) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'no terminal punctuation' };
		return { parseOk: true, parsedValue: { len: trimmed.length }, notes: '' };
	},
};

// ============================================================================
// 8. Mood synthesis (end-of-flow)
// ============================================================================
const buildSynthesisPrompt = (sc) => {
	const todayLines = [
		`- Mood score: ${sc.score}/10`,
		`- Emotions: ${sc.emotions.join(', ')}`,
		`- Activities: ${sc.activities.join(', ')}`,
		`- Sleep: ${sc.sleep} hours`,
	];
	return [
		`Roman just completed his mood check-in this evening. Here's what he shared today:\n\n${todayLines.join('\n')}`,
		`His past 7 days:\n${sc.recent}`,
		`Recent episodes worth noting:\n${sc.episodes}`,
		`His patterns and known triggers from past sessions:\n${sc.notes}`,
		'Respond as a supportive and understanding friend who notices patterns and helps him think. ' +
		'CRITICAL: only reference emotions Roman recorded TODAY. The 7-day history is for trend context, ' +
		"not for naming today's state — do not invent or mix in emotions from other days.",
		'If anything in the data suggests immediate safety concern, end your message with these helplines on a new line: Samaritans 116 123, SHOUT text 85258, NHS 111.',
	].join('\n\n');
};

const SYNTHESIS_TASK = {
	id: 'mood_synthesis',
	name: 'End-of-flow mood synthesis',
	sys: PERSONA,
	maxOutputTokens: 2000,
	requiresPersona: true,
	scenarios: [
		{ id: 'low_with_pattern', label: 'low + pattern present',
		  score: 3, emotions: ['anxious','lonely','tired','disappointed'], activities: ['work','no exercise'], sleep: 5,
		  recent: '- 2026-05-14: 5/10, tired, anxious\n- 2026-05-13: 6/10, calm\n- 2026-05-12: 4/10, sad, lonely\n- 2026-05-11: 3/10, anxious, tired',
		  episodes: '- [2026-05-08] Sunday loneliness episode: stayed home, did not call brother.',
		  notes: '- [pattern] Sundays cluster low\n- [trigger] Skipped exercise correlates with anxiety\n- [insight] Loneliness peaks 7-9pm' },
		{ id: 'high_breakthrough', label: 'high + breakthrough',
		  score: 8, emotions: ['proud','energetic','grateful'], activities: ['gym','code','social'], sleep: 8,
		  recent: '- 2026-05-14: 7/10, content\n- 2026-05-13: 6/10, calm\n- 2026-05-12: 5/10, neutral',
		  episodes: '- [2026-04-30] Last 8/10 was after the team shipped the launch.',
		  notes: '- [insight] Roman undersells positive states' },
		{ id: 'mixed_state', label: 'mixed state warning',
		  score: 6, emotions: ['anxious','energetic','irritable','focused'], activities: ['code'], sleep: 4,
		  recent: '- 2026-05-14: 7/10, energetic\n- 2026-05-13: 8/10, focused, restless\n- 2026-05-12: 5/10, anxious',
		  episodes: '- [2026-03-15] Last hypomanic episode was preceded by 3 days of <5h sleep.',
		  notes: '- [trigger] Sleep under 5h two nights in a row → mixed state risk\n- [pattern] Energy without rest precedes crash' },
		{ id: 'crisis_range', label: 'crisis (mood 1)',
		  score: 1, emotions: ['empty','hopeless','numb'], activities: ['none'], sleep: 11,
		  recent: '- 2026-05-14: 3/10, tired\n- 2026-05-13: 2/10, empty\n- 2026-05-12: 4/10',
		  episodes: '- [2025-11-12] Last 1/10 was the week before the GP appointment.',
		  notes: '- [trigger] Three days under 3/10 = call GP\n- [homework] If score ≤2, surface helplines' },
		{ id: 'stable_baseline', label: 'stable baseline',
		  score: 6, emotions: ['content','curious'], activities: ['walk','reading'], sleep: 7,
		  recent: '- 2026-05-14: 6/10, content\n- 2026-05-13: 6/10\n- 2026-05-12: 6/10',
		  episodes: 'No past episodes to reference.',
		  notes: '- [insight] Steady-state 6/10 is Roman\'s healthy baseline' },
	],
	validate(output, scenario) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const trimmed = output.trim();
		if (trimmed.length < 100)  return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too short' };
		if (trimmed.length > 3000) return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'too long' };
		if (/```/.test(trimmed))   return { parseOk: false, parsedValue: { len: trimmed.length }, notes: 'contains code fence' };

		// "Today-only emotions" anchor check: bot must not name an emotion that's
		// not in today's list. Pull all common emotion words from the output and
		// check none of them are off-today.
		const knownEmotions = ['anxious','lonely','tired','disappointed','content','curious','calm','sad','grateful','energetic','proud','irritable','focused','empty','hopeless','numb','overwhelmed','frustrated','restless','motivated','relaxed','happy','joyful','scared','angry','annoyed','insecure','confused','bored','nervous','lost','depressed'];
		const todaySet = new Set(scenario.emotions.map(e => e.toLowerCase()));
		const lowerOut = trimmed.toLowerCase();
		const offTodayMentioned = knownEmotions.filter(e => !todaySet.has(e) && new RegExp(`\\b${e}\\b`).test(lowerOut));
		const hallucinatesEmotion = offTodayMentioned.length > 0;
		return {
			parseOk: !hallucinatesEmotion,
			parsedValue: { len: trimmed.length, offTodayEmotions: offTodayMentioned },
			notes: hallucinatesEmotion ? `mentions off-today emotions: ${offTodayMentioned.slice(0,3).join(',')}` : '',
		};
	},
};

// ============================================================================
// 9. Persona evolution observations
// ============================================================================
const EVOLUTION_SYS = `You are analysing recent interactions between a user and their AI companion to extract DURABLE observations.

Your job: produce TWO short outputs that should persist across conversations.

=== OUTPUT 1: COMMUNICATION_NOTES (how the user prefers to be spoken to) ===
Look for evidence of:
- Preferred response length (terse vs detailed)
- Tone preferences (dry humour, warmth, directness, formality level)
- What kind of questions land well vs flat
- Specific phrasings or framings to avoid

=== OUTPUT 2: EVOLVED_TRAITS (stable user-specific patterns) ===
Look for evidence of:
- Topics of recurring interest (hobbies, work focus, ongoing projects)
- Stable emotional patterns
- Decision-making style
- Reliable cues that distinguish this user

=== HARD RULES ===
- Only include observations supported by REPEATED evidence across multiple data points.
- Skip transient mood states.
- Each line under 15 words. Total under 400 chars per output section.
- Third person about the user (e.g. "Roman tends to...").
- Do NOT invent. If evidence is thin, skip that section.
- If you have nothing high-confidence for EITHER section, return EXACTLY: NONE

=== OUTPUT FORMAT (strict) ===
COMMUNICATION_NOTES:
- bullet 1
- bullet 2

EVOLVED_TRAITS:
- bullet 1
- bullet 2

If one section has no high-confidence content, write "NONE" under that header. If BOTH sections are empty, return only the literal token NONE.`;

const buildEvolutionPrompt = (signals, existingTraits, existingNotes) => `Recent signals (${signals.length} total):

${signals.join('\n\n')}

=== CURRENT STATE ===
Existing evolved_traits: ${existingTraits}
Existing communication_notes: ${existingNotes}

Produce updated COMMUNICATION_NOTES and EVOLVED_TRAITS based on the signals. Preserve existing observations that are still supported; refine or add based on new evidence.`;

const EVOLUTION_TASK = {
	id: 'persona_evolution',
	name: 'Persona evolution observations',
	sys: EVOLUTION_SYS,
	maxOutputTokens: 700,
	requiresPersona: false,
	scenarios: [
		{ id: 'strong_signals', label: 'strong repeated evidence',
		  signals: [
			'[FEEDBACK imp=5] User disliked the framework name-drop in the last reply',
			'[FEEDBACK imp=4] User disliked when the bot opened with "I hear you"',
			'[FEEDBACK imp=5] User appreciated the dry humour',
			'[FEEDBACK imp=4] User appreciated the short, non-clinical tone',
			'[OBSERVATION] Implicit: Roman responds better to questions than to advice',
			'[OBSERVATION] Implicit: Roman re-engages when pushed back on, drops out when affirmed',
			'[PATTERN] Roman codes in the evening, talks about work in the morning',
		  ],
		  existingTraits: '(none yet)',
		  existingNotes: '(none yet)' },
		{ id: 'thin_evidence', label: 'thin / one-offs',
		  signals: [
			'[FEEDBACK imp=2] User liked the joke about Tuesday',
			'[OBSERVATION] Implicit: Roman went to a concert',
			'[RECENT USER MESSAGES]\n• morning\n• ok\n• thanks',
		  ],
		  existingTraits: '(none yet)',
		  existingNotes: '(none yet)' },
		{ id: 'update_existing', label: 'updates existing card',
		  signals: [
			'[FEEDBACK imp=4] User asked for longer technical explanations',
			'[FEEDBACK imp=3] User wanted code samples included',
			'[OBSERVATION] Implicit: Roman engages longer when reasoning is shown',
		  ],
		  existingTraits: '- Prefers 2-4 sentence replies\n- Direct over diplomatic',
		  existingNotes: '- Wants short answers' },
		{ id: 'contradictions', label: 'contradicting signals',
		  signals: [
			'[FEEDBACK imp=4] User liked the detailed breakdown',
			'[FEEDBACK imp=3] User found the reply too long',
			'[FEEDBACK imp=2] User wanted more depth',
		  ],
		  existingTraits: '(none yet)',
		  existingNotes: '- Prefers concise replies' },
		{ id: 'rich_history', label: 'rich signal mix',
		  signals: [
			'[FEEDBACK imp=5] User disliked therapy-speak',
			'[FEEDBACK imp=4] User appreciated being challenged',
			'[OBSERVATION] Implicit: Roman runs three times a week',
			'[OBSERVATION] Implicit: Roman is rebuilding the bot architecture',
			'[PATTERN] Loneliness peaks Sunday evenings',
			'[PATTERN] Roman opens up after the third question',
			'[RECENT USER MESSAGES]\n• fix this\n• why did it crash\n• ok try option 2',
		  ],
		  existingTraits: '(none yet)',
		  existingNotes: '(none yet)' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const trimmed = output.trim();
		if (/^NONE\s*$/i.test(trimmed)) return { parseOk: true, parsedValue: 'NONE', notes: 'returned NONE' };
		const hasNotes  = /COMMUNICATION_NOTES:/i.test(trimmed);
		const hasTraits = /EVOLVED_TRAITS:/i.test(trimmed);
		if (!hasNotes && !hasTraits) return { parseOk: false, parsedValue: null, notes: 'missing both section headers' };
		const hasBullets = /^- /m.test(trimmed) || /^\*/m.test(trimmed);
		if (!hasBullets) return { parseOk: false, parsedValue: { hasNotes, hasTraits }, notes: 'no bullets' };
		return { parseOk: true, parsedValue: { hasNotes, hasTraits, len: trimmed.length }, notes: '' };
	},
};

// ============================================================================
// 10. Response curator (JSON output)
// ============================================================================
const CURATOR_SYS = `You are a pre-response curator for an AI companion called Xaridotis.

A user just sent a message. You have access to retrieved memories and recent chat history. Your job is NOT to respond to the user. Your job is to produce a STRUCTURED ANALYSIS that the main model will use to ground its reply.

Return ONLY valid JSON, no markdown:
{
  "register": "casual" | "warm" | "technical" | "urgent",
  "flags": [array of strings, see below],
  "relevant_memory_ids": [array of memory ids that genuinely relate to this turn],
  "reasoning": "1-2 sentence summary of what's happening and what the main model should attend to"
}

REGISTER GUIDE:
- casual: small talk, status updates, light chat
- warm: emotional content, vulnerability, distress, reflection
- technical: code, architecture, debugging, research, structured planning
- urgent: crisis signals, safety concerns, acute distress

FLAGS (include any that apply, omit empty):
- crisis | med_question | positive_state | negative_state | recall_request | project_continuity | correction | topic_change | short_ack

HARD RULES:
- Only include memory_ids that ACTUALLY relate to the current message.
- Reasoning under 200 chars.
- Do NOT invent flags or memories.
- Output ONLY the JSON object. No preamble, no markdown fences.`;

const buildCuratorPrompt = (userText, memories, history) => {
	const memorySection = memories.length
		? memories.map(m => `[id=${m.id}|${m.category}] ${m.fact}`).join('\n')
		: '(no memories)';
	const historySection = history.length
		? history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n')
		: '(no recent history)';
	return `INCOMING USER MESSAGE:\n${userText}\n\nRETRIEVED MEMORIES:\n${memorySection}\n\nRECENT HISTORY:\n${historySection}\n\nProduce the JSON analysis.`;
};

const CURATOR_TASK = {
	id: 'curator',
	name: 'Response curator (JSON)',
	sys: CURATOR_SYS,
	maxOutputTokens: 800,
	requiresPersona: false,
	useJsonMode: true,
	scenarios: [
		{ id: 'warm', label: 'emotional / warm', userText: "I just can't shake this. It's been three weeks and I still feel hollow.",
		  memories: [
			{ id: 11, category: 'pattern', fact: 'Loneliness peaks on Sunday evenings.' },
			{ id: 12, category: 'episode', fact: 'Last bereavement check-in was 2026-04-20.' },
			{ id: 13, category: 'preference', fact: 'Roman drinks pour-over coffee.' },
		  ],
		  history: [
			{ role: 'user', text: 'mood is rough today' },
			{ role: 'bot',  text: 'Noticed. Want to talk it through?' },
		  ]},
		{ id: 'technical', label: 'technical', userText: 'The fallback isn\'t firing on Pro 3.1 503s. Cascade walker is in handlers.js around line 1950.',
		  memories: [
			{ id: 21, category: 'project', fact: 'Working on Xaridotis cascade fallback.' },
			{ id: 22, category: 'preference', fact: 'British English, no em dashes.' },
			{ id: 23, category: 'mood', fact: 'Tired today.' },
		  ],
		  history: [
			{ role: 'user', text: 'check the tail again' },
			{ role: 'bot',  text: 'cascade_fallback log line missing in last run' },
		  ]},
		{ id: 'casual', label: 'casual short', userText: 'morning',
		  memories: [
			{ id: 31, category: 'preference', fact: 'Roman drinks pour-over coffee.' },
		  ],
		  history: []},
		{ id: 'urgent', label: 'crisis signal', userText: 'I keep thinking about how much easier it would be if I just stopped.',
		  memories: [
			{ id: 41, category: 'trigger', fact: 'Three days low scores → escalate.' },
			{ id: 42, category: 'homework', fact: 'If crisis signal, surface Samaritans.' },
			{ id: 43, category: 'preference', fact: 'Roman drinks pour-over coffee.' },
		  ],
		  history: [
			{ role: 'user', text: 'mood: 2/10' },
			{ role: 'bot',  text: 'That\'s the third day in a row.' },
		  ]},
		{ id: 'recall', label: 'recall request', userText: 'What did we land on for the curator latency issue last week?',
		  memories: [
			{ id: 51, category: 'project', fact: 'Curator latency fix proposed: Hermes Tier 1 with cascade Tier 2+.' },
			{ id: 52, category: 'project', fact: 'Roma decided to bench all models before re-architecting.' },
			{ id: 53, category: 'preference', fact: 'Metric units by default.' },
		  ],
		  history: []},
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, parsedValue: null, notes: 'no output' };
		const cleaned = output.replace(/```json|```/g, '').trim();
		let parsed = null;
		try { parsed = JSON.parse(cleaned); } catch {
			const match = cleaned.match(/\{[\s\S]*\}/);
			if (match) { try { parsed = JSON.parse(match[0]); } catch { /* fail */ } }
		}
		if (!parsed) return { parseOk: false, parsedValue: null, notes: 'unparseable JSON' };
		const validRegisters = ['casual','warm','technical','urgent'];
		const registerOk = validRegisters.includes(parsed.register);
		const flagsOk = Array.isArray(parsed.flags);
		const idsOk = Array.isArray(parsed.relevant_memory_ids);
		const reasoningOk = typeof parsed.reasoning === 'string';
		const ok = registerOk && flagsOk && idsOk && reasoningOk;
		return {
			parseOk: ok,
			parsedValue: { register: parsed.register, flags: parsed.flags, relevant_memory_ids: parsed.relevant_memory_ids, reasoning: parsed.reasoning?.slice(0, 100) },
			notes: ok ? '' : `shape fail: register=${registerOk} flags=${flagsOk} ids=${idsOk} reasoning=${reasoningOk}`,
		};
	},
};

// ============================================================================
// Export with input builders bound to scenarios
// ============================================================================
function buildInput(taskId, scenario) {
	switch (taskId) {
		case 'mode_classifier':       return buildModePrompt(scenario.history, scenario.current);
		case 'triple_extraction':     return buildTriplePrompt(scenario.userText, scenario.botResponse);
		case 'mood_tagging':          return buildMoodTagPrompt(scenario.score, scenario.emotions, scenario.note);
		case 'memory_dedup':          return buildDedupPrompt(scenario.memories);
		case 'style_card':            return buildStylePrompt(scenario.current, scenario.feedback);
		case 'mood_score_ack':        return buildScoreAckPrompt(scenario.period, scenario.score, scenario.scoresList, scenario.therapeuticNotes);
		case 'mood_emotions_ack':     return buildEmotionsAckPrompt(scenario.period, scenario.emotions, scenario.emotionsList, scenario.therapeuticNotes);
		case 'mood_synthesis':        return buildSynthesisPrompt(scenario);
		case 'persona_evolution':     return buildEvolutionPrompt(scenario.signals, scenario.existingTraits, scenario.existingNotes);
		case 'curator':               return buildCuratorPrompt(scenario.userText, scenario.memories, scenario.history);
		default: throw new Error(`Unknown task: ${taskId}`);
	}
}

export const TASKS = [
	MODE_TASK, TRIPLE_TASK, MOOD_TAG_TASK, DEDUP_TASK, STYLE_TASK,
	MOOD_SCORE_TASK, MOOD_EMO_TASK, SYNTHESIS_TASK, EVOLUTION_TASK, CURATOR_TASK,
];

export { buildInput };
