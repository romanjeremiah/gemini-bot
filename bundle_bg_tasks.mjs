// bundle_bg_tasks.mjs
//
// Background-task benchmark for Xaridotis cascade re-architecture.
//
// Tests 25 candidate models on 10 production background-task prompts with
// ITERATIONS iterations per (model, task, scenario) triple to suppress
// sampling variance at temperature 1.0.
//
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
// 25 models × 10 tasks × 5 scenarios × ITERATIONS iter calls.
//   At ITERATIONS=3 → 3750 calls, ~25 min wall, ~£25 cost.
//   At ITERATIONS=1 → 1250 calls, ~10 min wall, ~£8 cost.
//
// Run:
//   cd ~/Library/CloudStorage/OneDrive-Personal/Documents/GitHub/gemini-bot
//   node bundle_bg_tasks.mjs
//
// Required env: GEMINI_API_KEY, CF_API_TOKEN
// Optional env: CF_ACCOUNT_ID (defaults to bc6018c200086c59663c8ff798e689fa)
//
// Output: bg_task_bench_<timestamp>.md + bg_task_bench_<timestamp>.csv

import { writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { personas } from './src/config/personas.js';

// ============================================================================
// Config
// ============================================================================

const PERSONA            = personas.xaridotis.instruction;
const TEMPERATURE        = 1.0;
const ITERATIONS         = 3;
const CONCURRENCY        = 15;    // was 5 (preflight saw zero rate-limit signals)
const HARD_TIMEOUT_MS    = 60000; // was 30000 (Pro variants + persona-heavy tasks)
const CF_ACCOUNT_DEFAULT = 'bc6018c200086c59663c8ff798e689fa';

const { GEMINI_API_KEY, CF_API_TOKEN } = process.env;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || CF_ACCOUNT_DEFAULT;

if (!GEMINI_API_KEY || !CF_API_TOKEN) {
	console.error('Missing env. Required: GEMINI_API_KEY, CF_API_TOKEN');
	console.error('CF_ACCOUNT_ID defaults to ' + CF_ACCOUNT_DEFAULT + ' if unset.');
	process.exit(1);
}

console.log(`Loaded Xaridotis persona (${PERSONA.length} chars)`);
console.log(`Iterations per (model, task, scenario): ${ITERATIONS}`);
console.log(`CF account: ${CF_ACCOUNT_ID}`);
console.log('');

const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ============================================================================
// Model registry  (25 = 16 CF + 9 Gemini)
// ============================================================================

const MODELS = [
	// ---- Cloudflare Workers AI (16) ----
	{ id: 'cf:kimi-k2.6',           kind: 'cf', model: '@cf/moonshotai/kimi-k2.6',                       label: 'kimi-k2.6' },
	{ id: 'cf:glm-4.7-flash',       kind: 'cf', model: '@cf/zai-org/glm-4.7-flash',                       label: 'glm-4.7-flash' },
	{ id: 'cf:gpt-oss-120b',        kind: 'cf', model: '@cf/openai/gpt-oss-120b',                          label: 'gpt-oss-120b' },
	{ id: 'cf:gpt-oss-20b',         kind: 'cf', model: '@cf/openai/gpt-oss-20b',                           label: 'gpt-oss-20b' },
	{ id: 'cf:llama-4-scout-17b',   kind: 'cf', model: '@cf/meta/llama-4-scout-17b-16e-instruct',          label: 'llama-4-scout-17b' },
	{ id: 'cf:gemma-4-26b',         kind: 'cf', model: '@cf/google/gemma-4-26b-a4b-it',                    label: 'gemma-4-26b' },
	{ id: 'cf:nemotron-3-120b',     kind: 'cf', model: '@cf/nvidia/nemotron-3-120b-a12b',                  label: 'nemotron-3-120b' },
	{ id: 'cf:granite-4.0-h-micro', kind: 'cf', model: '@cf/ibm-granite/granite-4.0-h-micro',              label: 'granite-4.0-h-micro' },
	{ id: 'cf:qwen3-30b-a3b-fp8',   kind: 'cf', model: '@cf/qwen/qwen3-30b-a3b-fp8',                        label: 'qwen3-30b-a3b-fp8' },
	{ id: 'cf:mistral-small-3.1',   kind: 'cf', model: '@cf/mistralai/mistral-small-3.1-24b-instruct',     label: 'mistral-small-3.1-24b' },
	{ id: 'cf:qwq-32b',             kind: 'cf', model: '@cf/qwen/qwq-32b',                                  label: 'qwq-32b' },
	{ id: 'cf:qwen2.5-coder-32b',   kind: 'cf', model: '@cf/qwen/qwen2.5-coder-32b-instruct',               label: 'qwen2.5-coder-32b' },
	{ id: 'cf:deepseek-r1-32b',     kind: 'cf', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',      label: 'deepseek-r1-distill-32b' },
	{ id: 'cf:llama-3.3-70b-fast',  kind: 'cf', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',          label: 'llama-3.3-70b-fp8-fast' },
	{ id: 'cf:llama-3.2-3b',        kind: 'cf', model: '@cf/meta/llama-3.2-3b-instruct',                   label: 'llama-3.2-3b' },
	{ id: 'cf:llama-3.1-8b-fp8',    kind: 'cf', model: '@cf/meta/llama-3.1-8b-instruct-fp8',                label: 'llama-3.1-8b-fp8' },

	// ---- Gemini (9 variants) ----
	{ id: 'gem:flash-3',     kind: 'gemini', model: 'gemini-3-flash-preview',         label: 'gemini-3-flash' },
	{ id: 'gem:3.1-fl',      kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  label: 'gemini-3.1-fl' },
	{ id: 'gem:3.1-fl-min',  kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'minimal' }, label: 'gemini-3.1-fl-min' },
	{ id: 'gem:3.1-fl-med',  kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'medium' },  label: 'gemini-3.1-fl-med' },
	{ id: 'gem:2.5-fl-dyn',  kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: -1 },       label: 'gemini-2.5-fl-dyn' },
	{ id: 'gem:2.5-fl-b512', kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: 512 },      label: 'gemini-2.5-fl-b512' },
	{ id: 'gem:2.5-pro-dyn', kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: -1 },       label: 'gemini-2.5-pro-dyn' },
	{ id: 'gem:2.5-pro-b128',kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: 128 },      label: 'gemini-2.5-pro-b128' },
	{ id: 'gem:3.1-pro',     kind: 'gemini', model: 'gemini-3.1-pro-preview',         label: 'gemini-3.1-pro' },
];

// ============================================================================
// Task 1 — Mode classifier
// ============================================================================

const MODE_SYS = 'You classify conversational modes. Output only one word.';
const buildMode = (s) => `Classify the user's most recent message into ONE of these modes:

venting — emotional discharge, repeating a painful thought, not asking for help, just needs to be heard. Examples: "He's ignoring me", "I can't stop thinking about it", "I'm just done"
processing — actively trying to understand or work through something, open to questions and reflection. Examples: "Why does this keep happening?", "Help me think this through", "What do you make of this?"
transactional — practical request: reminder, lookup, code, info, scheduling. No emotional content. Examples: "Remind me at 9am", "What time is it in Tokyo?", "Fix this code"
crisis — severe distress: suicidal thoughts, self-harm, dissociation, total breakdown, mood 0-1 territory. Examples: "I want to die", "I can't feel anything", "I can't go on"

RECENT CONVERSATION:
${s.history || '(no prior context)'}

CURRENT USER MESSAGE: ${s.current}

Respond with ONLY one word: venting, processing, transactional, or crisis.`;

const MODE_TASK = {
	id: 'mode_classifier',
	name: 'Conversation mode classifier',
	sys: MODE_SYS,
	maxOutputTokens: 2000,
	build: buildMode,
	scenarios: [
		{ id: 'venting',       label: 'clear venting',       expected: 'venting',       history: 'USER: Why does no one ever notice when I am struggling?', current: "I'm just done. I can't keep pretending everything is fine when nobody actually cares." },
		{ id: 'processing',    label: 'clear processing',    expected: 'processing',    history: 'USER: I had another panic attack at work today.', current: "Why does this keep happening when I'm doing all the things I'm supposed to? Help me think this through." },
		{ id: 'transactional', label: 'clear transactional', expected: 'transactional', history: '', current: 'Remind me to call the dentist tomorrow at 9am.' },
		{ id: 'crisis',        label: 'crisis signal',       expected: 'crisis',        history: 'USER: I went to bed at noon and only just got up.', current: "I don't want to be here anymore. I keep thinking about how much easier it would be if I just stopped." },
		{ id: 'ambiguous',     label: 'ambiguous short',     expected: null,            history: 'BOT: Mood logged at 6/10.', current: 'okay' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const m = output.toLowerCase().match(/\b(venting|processing|transactional|crisis)\b/);
		if (!m) return { parseOk: false, notes: 'no mode keyword' };
		return { parseOk: true, parsedValue: m[1], notes: '' };
	},
};

// ============================================================================
// Task 2 — Triple extraction (knowledge graph SPO)
// ============================================================================

const TRIPLE_SYS = 'You are a silent observer. Be concise. Only note genuinely new information.';
const buildTriple = (s) => `You observed this exchange:
USER: ${s.userText}
BOT: ${s.botResponse}

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
	build: buildTriple,
	scenarios: [
		{ id: 'preference_emerge', label: 'preference reveal', shouldFindTriples: true,  userText: "I made another batch of sourdough this morning. It's the third weekend in a row.", botResponse: 'Three weekends in a row — sourdough is becoming a ritual.' },
		{ id: 'work_context',      label: 'work / project',    shouldFindTriples: true,  userText: 'Spent the whole day refactoring the auth flow. Burnt out but it works now.', botResponse: 'Auth refactor done. How does the new flow handle session timeout?' },
		{ id: 'pattern_emotional', label: 'emotional pattern', shouldFindTriples: true,  userText: "I always feel worse after seeing my mum. Don't know why I keep visiting.", botResponse: "That's a real pattern worth naming. What changes between before and after?" },
		{ id: 'nothing_new',       label: 'no new info',       shouldFindTriples: false, userText: 'thanks', botResponse: 'You got it.' },
		{ id: 'goal_statement',    label: 'goal / commitment', shouldFindTriples: true,  userText: "I'm signing up for the Edinburgh marathon next year.", botResponse: 'Edinburgh. Hilly but beautiful. Training plan in mind?' },
	],
	validate(output, scenario) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const upper = output.toUpperCase();
		const hasNothing = upper.includes('NOTHING_NEW');
		const hasObs = upper.includes('OBSERVATION:');
		const tripleCount = (output.match(/TRIPLE:\s*\S+/gi) || []).length;
		if (scenario.shouldFindTriples) {
			const ok = (hasObs || tripleCount >= 1) && !hasNothing;
			return { parseOk: ok, parsedValue: { obs: hasObs, triples: tripleCount }, notes: ok ? '' : 'expected triples/observation' };
		}
		const ok = hasNothing || (tripleCount === 0 && !hasObs);
		return { parseOk: ok, parsedValue: { obs: hasObs, triples: tripleCount }, notes: ok ? '' : 'expected NOTHING_NEW' };
	},
};

// ============================================================================
// Task 3 — Mood entry clinical tagging
// ============================================================================

const MOOD_TAG_SYS = 'You are a clinical tagger. Return only tags, no explanation.';
const ALLOWED_MOOD_TAGS = ['depressive_episode','anxiety_state','hypomanic_signs','stable_baseline','mixed_state','crisis_risk','productive_phase','social_withdrawal','sleep_disruption','medication_response'];
const buildMoodTag = (s) => `Mood score: ${s.score}/10. Emotions: ${(s.emotions || []).join(', ')}. Note: ${(s.note || 'none')}.

Tag this entry with 1-3 clinical categories from this list:
${ALLOWED_MOOD_TAGS.join(', ')}

Respond with ONLY the tags, comma-separated. Example: anxiety_state, sleep_disruption`;

const MOOD_TAG_TASK = {
	id: 'mood_tagging',
	name: 'Mood entry clinical tagging',
	sys: MOOD_TAG_SYS,
	maxOutputTokens: 200,
	build: buildMoodTag,
	scenarios: [
		{ id: 'low_anxious',     label: 'low + anxious',     score: 3, emotions: ['anxious','tired','overwhelmed'],    note: "Couldn't sleep, work feels too much." },
		{ id: 'high_productive', label: 'high + productive', score: 8, emotions: ['energetic','focused','motivated'],  note: 'Three deep work blocks today.' },
		{ id: 'crisis',          label: 'crisis range',      score: 1, emotions: ['empty','hopeless','numb'],          note: 'Stayed in bed all day.' },
		{ id: 'mixed',           label: 'mixed state',       score: 6, emotions: ['anxious','energetic','irritable'], note: 'Brain racing but body wired.' },
		{ id: 'baseline',        label: 'stable baseline',   score: 6, emotions: ['calm','content'],                   note: 'Normal day.' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const tags = output.toLowerCase().split(/[,\n]/).map(t => t.trim()).filter(Boolean);
		const valid = tags.filter(t => ALLOWED_MOOD_TAGS.includes(t));
		if (valid.length < 1) return { parseOk: false, parsedValue: tags, notes: 'no valid tags' };
		if (valid.length > 3) return { parseOk: false, parsedValue: valid, notes: 'too many tags' };
		return { parseOk: true, parsedValue: valid, notes: '' };
	},
};

// ============================================================================
// Task 4 — Memory deduplication
// ============================================================================

const DEDUP_SYS = 'You are a data organiser. Be precise with indices. For contradictions, always list the OLDER memory first in each pair.';
const buildDedup = (s) => {
	const list = s.memories.map((m, i) => `[${i}] [${m.category}] ${m.fact} (${m.created_at})`).join('\n');
	return `Here are ${s.memories.length} stored memories. Identify:
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

const DEDUP_BASIC = [
	{ category: 'preference', fact: 'Roman drinks pour-over coffee in the morning.',       created_at: '2026-04-01 08:00:00' },
	{ category: 'preference', fact: 'Morning coffee is pour-over for Roman.',               created_at: '2026-04-15 08:00:00' },
	{ category: 'work',       fact: 'Roman is refactoring the auth flow in Eukara.',        created_at: '2026-04-20 14:00:00' },
	{ category: 'work',       fact: 'Auth refactor in Eukara is complete.',                 created_at: '2026-05-01 14:00:00' },
	{ category: 'health',     fact: 'Roman has been doing 30-min runs three times a week.', created_at: '2026-04-22 19:00:00' },
	{ category: 'health',     fact: 'Roman switched from running to swimming this month.',  created_at: '2026-05-10 19:00:00' },
	{ category: 'social',     fact: 'Roman has weekly dinners with his brother Marcus.',    created_at: '2026-03-15 19:00:00' },
	{ category: 'social',     fact: 'Brother Marcus visits Roman every Thursday.',          created_at: '2026-04-20 19:00:00' },
];

const DEDUP_TASK = {
	id: 'memory_dedup',
	name: 'Memory deduplication',
	sys: DEDUP_SYS,
	maxOutputTokens: 3000,
	build: buildDedup,
	scenarios: [
		{ id: 'all_categories', label: 'mixed categories',    memories: DEDUP_BASIC },
		{ id: 'no_dups',        label: 'no duplicates',       memories: [
			{ category: 'preference', fact: 'Roman prefers dark roast coffee.', created_at: '2026-04-01' },
			{ category: 'work',       fact: 'Roman works on Xaridotis daily.',  created_at: '2026-04-10' },
			{ category: 'health',     fact: 'Roman runs three times a week.',   created_at: '2026-04-15' },
		]},
		{ id: 'heavy_dups', label: 'many duplicates', memories: [
			{ category: 'pref', fact: 'Roman is vegetarian.',                created_at: '2026-03-01' },
			{ category: 'pref', fact: 'Roman does not eat meat.',            created_at: '2026-03-10' },
			{ category: 'pref', fact: 'Roman follows a vegetarian diet.',    created_at: '2026-04-01' },
			{ category: 'pref', fact: 'Roman avoids meat in his meals.',     created_at: '2026-04-15' },
		]},
		{ id: 'contradictions', label: 'contradiction-heavy', memories: [
			{ category: 'job', fact: 'Roman works as a backend engineer at Acme.', created_at: '2026-01-01' },
			{ category: 'job', fact: 'Roman switched to a frontend role at Acme.', created_at: '2026-03-15' },
			{ category: 'loc', fact: 'Roman lives in Manchester.',                  created_at: '2026-01-01' },
			{ category: 'loc', fact: 'Roman moved to London in April.',             created_at: '2026-04-10' },
		]},
		{ id: 'topical_groups', label: 'topical clusters', memories: [
			{ category: 'adhd', fact: 'Roman struggles with task initiation.',     created_at: '2026-04-01' },
			{ category: 'adhd', fact: 'Roman uses body-doubling for hard tasks.',  created_at: '2026-04-10' },
			{ category: 'adhd', fact: 'Roman finds hyperfocus useful for code.',   created_at: '2026-04-15' },
			{ category: 'mood', fact: 'Roman feels lonely on Sunday evenings.',    created_at: '2026-04-20' },
			{ category: 'mood', fact: 'Sunday loneliness is a recurring pattern.', created_at: '2026-05-01' },
		]},
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const hasDups = /DUPLICATES:/i.test(output);
		const hasContras = /CONTRADICTIONS:/i.test(output);
		const hasGroups = /GROUP:/i.test(output);
		const dupPairs = [...output.matchAll(/\[(\d+),\s*(\d+)\]/g)].length;
		const groupCount = [...output.matchAll(/GROUP:\s*[^:]+:\s*\[[^\]]+\]/g)].length;
		const ok = hasDups || hasContras || hasGroups;
		return { parseOk: ok, parsedValue: { dupPairs, groupCount, hasDups, hasContras, hasGroups }, notes: ok ? '' : 'missing all DUPLICATES/CONTRADICTIONS/GROUP markers' };
	},
};

// ============================================================================
// Task 5 — Style card consolidation
// ============================================================================

const STYLE_SYS = 'You update style cards by integrating user feedback. Return only the updated style card, no commentary.';
const STYLE_BASE = `# Communication style for Roman

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

const buildStyle = (s) => `You are updating a user's communication style card based on their recent feedback signals.

CURRENT STYLE CARD:
${s.current}

RECENT FEEDBACK FROM USER REACTIONS:
${s.feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}

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
	build: buildStyle,
	scenarios: [
		{ id: 'reinforce',  label: 'reinforce existing',   current: STYLE_BASE, feedback: ['User appreciated the short, non-clinical tone','User disliked when the bot opened with "That sounds hard"','User found the dry humour landing well'] },
		{ id: 'contradict', label: 'contradicts existing', current: STYLE_BASE, feedback: ['User asked for longer explanations on technical topics','User wanted more reasoning shown step by step'] },
		{ id: 'novel',      label: 'new dimensions',       current: STYLE_BASE, feedback: ['User preferred British spellings throughout','User wanted metric units by default','User disliked the use of "lol" in replies'] },
		{ id: 'mixed',      label: 'mixed signals',        current: STYLE_BASE, feedback: ['User disliked the framework name-drop in the last reply','User appreciated when the bot pushed back on a flawed assumption','User found the question too leading'] },
		{ id: 'minimal',    label: 'single feedback',      current: STYLE_BASE, feedback: ['User wanted code examples to use TypeScript, not Python'] },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const t = output.trim();
		if (t.length < 100)  return { parseOk: false, parsedValue: { len: t.length }, notes: 'too short' };
		if (t.length > 4000) return { parseOk: false, parsedValue: { len: t.length }, notes: 'too long' };
		if (/^```/.test(t))  return { parseOk: false, parsedValue: { len: t.length }, notes: 'wrapped in markdown fence' };
		const hasSection = /^##? \w/m.test(t) || /^- /m.test(t);
		if (!hasSection)     return { parseOk: false, parsedValue: { len: t.length }, notes: 'no section structure' };
		return { parseOk: true, parsedValue: { len: t.length }, notes: '' };
	},
};

// ============================================================================
// Task 6 — Mood score micro-acknowledgement
// ============================================================================

const buildScoreAck = (s) => `Roman just logged his mood ${s.period} as ${s.score} out of 10.

The mood scale used here:
0 = severe depression / unable to function
2 = struggling, hard to get through the day
5 = mixed, neutral, doing OK
7 = good, energy and motivation present
9 = unusually elevated, watch for hypomania

His recent scores over the last 5 days were:
${s.scoresList}

His patterns and known triggers from past sessions:
${s.therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices.`;

const MOOD_SCORE_TASK = {
	id: 'mood_score_ack',
	name: 'Mood score micro-acknowledgement',
	sys: PERSONA,
	maxOutputTokens: 1500,
	build: buildScoreAck,
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
		  therapeuticNotes: '- [trigger] Three days of low scores indicates risk of dip\n- [homework] If score <=2, surface Samaritans 116 123' },
		{ id: 'first_entry', label: 'no history',    period: 'this evening', score: 6,
		  scoresList: 'No recent scores on file.',
		  therapeuticNotes: 'No therapeutic notes on file yet.' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const t = output.trim();
		if (t.length < 30)  return { parseOk: false, parsedValue: { len: t.length }, notes: 'too short' };
		if (t.length > 600) return { parseOk: false, parsedValue: { len: t.length }, notes: 'too long' };
		if (/```/.test(t))  return { parseOk: false, parsedValue: { len: t.length }, notes: 'contains code fence' };
		if (/^\s*\{/.test(t)) return { parseOk: false, parsedValue: { len: t.length }, notes: 'looks like JSON' };
		if (!/[.!?]$/.test(t)) return { parseOk: false, parsedValue: { len: t.length }, notes: 'no terminal punctuation' };
		return { parseOk: true, parsedValue: { len: t.length }, notes: '' };
	},
};

// ============================================================================
// Task 7 — Mood emotions micro-acknowledgement
// ============================================================================

const buildEmotionsAck = (s) => `Roman just logged these emotions ${s.period}: ${s.emotions.join(', ')}.

His emotions over the last 5 days were:
${s.emotionsList}

His patterns and known schemas from past sessions:
${s.therapeuticNotes}

Briefly respond as a supportive and understanding friend who notices patterns.`;

const MOOD_EMO_TASK = {
	id: 'mood_emotions_ack',
	name: 'Mood emotions micro-acknowledgement',
	sys: PERSONA,
	maxOutputTokens: 1500,
	build: buildEmotionsAck,
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
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const t = output.trim();
		if (t.length < 30)  return { parseOk: false, parsedValue: { len: t.length }, notes: 'too short' };
		if (t.length > 800) return { parseOk: false, parsedValue: { len: t.length }, notes: 'too long' };
		if (/```/.test(t))  return { parseOk: false, parsedValue: { len: t.length }, notes: 'contains code fence' };
		if (/^\s*\{/.test(t)) return { parseOk: false, parsedValue: { len: t.length }, notes: 'looks like JSON' };
		if (!/[.!?]$/.test(t)) return { parseOk: false, parsedValue: { len: t.length }, notes: 'no terminal punctuation' };
		return { parseOk: true, parsedValue: { len: t.length }, notes: '' };
	},
};

// ============================================================================
// Task 8 — End-of-flow mood synthesis (today-only anti-hallucination check)
// ============================================================================

const buildSynth = (s) => {
	const today = [`- Mood score: ${s.score}/10`, `- Emotions: ${s.emotions.join(', ')}`, `- Activities: ${s.activities.join(', ')}`, `- Sleep: ${s.sleep} hours`];
	return [
		`Roman just completed his mood check-in this evening. Here's what he shared today:\n\n${today.join('\n')}`,
		`His past 7 days:\n${s.recent}`,
		`Recent episodes worth noting:\n${s.episodes}`,
		`His patterns and known triggers from past sessions:\n${s.notes}`,
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
	build: buildSynth,
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
		  notes: '- [trigger] Sleep under 5h two nights in a row -> mixed state risk\n- [pattern] Energy without rest precedes crash' },
		{ id: 'crisis_range', label: 'crisis (mood 1)',
		  score: 1, emotions: ['empty','hopeless','numb'], activities: ['none'], sleep: 11,
		  recent: '- 2026-05-14: 3/10, tired\n- 2026-05-13: 2/10, empty\n- 2026-05-12: 4/10',
		  episodes: '- [2025-11-12] Last 1/10 was the week before the GP appointment.',
		  notes: '- [trigger] Three days under 3/10 = call GP\n- [homework] If score <=2, surface helplines' },
		{ id: 'stable_baseline', label: 'stable baseline',
		  score: 6, emotions: ['content','curious'], activities: ['walk','reading'], sleep: 7,
		  recent: '- 2026-05-14: 6/10, content\n- 2026-05-13: 6/10\n- 2026-05-12: 6/10',
		  episodes: 'No past episodes to reference.',
		  notes: '- [insight] Steady-state 6/10 is Roman\'s healthy baseline' },
	],
	validate(output, scenario) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const t = output.trim();
		if (t.length < 100)  return { parseOk: false, parsedValue: { len: t.length }, notes: 'too short' };
		if (t.length > 3000) return { parseOk: false, parsedValue: { len: t.length }, notes: 'too long' };
		if (/```/.test(t))   return { parseOk: false, parsedValue: { len: t.length }, notes: 'contains code fence' };
		const knownEmotions = ['anxious','lonely','tired','disappointed','content','curious','calm','sad','grateful','energetic','proud','irritable','focused','empty','hopeless','numb','overwhelmed','frustrated','restless','motivated','relaxed','happy','joyful','scared','angry','annoyed','insecure','confused','bored','nervous','lost','depressed','exhausted'];
		const todaySet = new Set(scenario.emotions.map(e => e.toLowerCase()));
		const lower = t.toLowerCase();
		const offToday = knownEmotions.filter(e => !todaySet.has(e) && new RegExp(`\\b${e}\\b`).test(lower));
		const hallucinates = offToday.length > 0;
		return {
			parseOk: !hallucinates,
			parsedValue: { len: t.length, offTodayEmotions: offToday },
			notes: hallucinates ? `mentions off-today emotions: ${offToday.slice(0, 3).join(',')}` : '',
		};
	},
};

// ============================================================================
// Task 9 — Persona evolution observations
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

const buildEvolution = (s) => `Recent signals (${s.signals.length} total):

${s.signals.join('\n\n')}

=== CURRENT STATE ===
Existing evolved_traits: ${s.existingTraits}
Existing communication_notes: ${s.existingNotes}

Produce updated COMMUNICATION_NOTES and EVOLVED_TRAITS based on the signals. Preserve existing observations that are still supported; refine or add based on new evidence.`;

const EVOLUTION_TASK = {
	id: 'persona_evolution',
	name: 'Persona evolution observations',
	sys: EVOLUTION_SYS,
	maxOutputTokens: 700,
	build: buildEvolution,
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
		  existingTraits: '(none yet)', existingNotes: '(none yet)' },
		{ id: 'thin_evidence', label: 'thin / one-offs',
		  signals: [
			'[FEEDBACK imp=2] User liked the joke about Tuesday',
			'[OBSERVATION] Implicit: Roman went to a concert',
			'[RECENT USER MESSAGES]\n* morning\n* ok\n* thanks',
		  ],
		  existingTraits: '(none yet)', existingNotes: '(none yet)' },
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
		  existingTraits: '(none yet)', existingNotes: '- Prefers concise replies' },
		{ id: 'rich_history', label: 'rich signal mix',
		  signals: [
			'[FEEDBACK imp=5] User disliked therapy-speak',
			'[FEEDBACK imp=4] User appreciated being challenged',
			'[OBSERVATION] Implicit: Roman runs three times a week',
			'[OBSERVATION] Implicit: Roman is rebuilding the bot architecture',
			'[PATTERN] Loneliness peaks Sunday evenings',
			'[PATTERN] Roman opens up after the third question',
			'[RECENT USER MESSAGES]\n* fix this\n* why did it crash\n* ok try option 2',
		  ],
		  existingTraits: '(none yet)', existingNotes: '(none yet)' },
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const t = output.trim();
		if (/^NONE\s*$/i.test(t)) return { parseOk: true, parsedValue: 'NONE', notes: 'returned NONE' };
		const hasNotes = /COMMUNICATION_NOTES:/i.test(t);
		const hasTraits = /EVOLVED_TRAITS:/i.test(t);
		if (!hasNotes && !hasTraits) return { parseOk: false, notes: 'missing both section headers' };
		const hasBullets = /^- /m.test(t) || /^\*/m.test(t);
		if (!hasBullets) return { parseOk: false, parsedValue: { hasNotes, hasTraits }, notes: 'no bullets' };
		return { parseOk: true, parsedValue: { hasNotes, hasTraits, len: t.length }, notes: '' };
	},
};

// ============================================================================
// Task 10 — Response curator (JSON)
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

const buildCurator = (s) => {
	const memSection = s.memories.length ? s.memories.map(m => `[id=${m.id}|${m.category}] ${m.fact}`).join('\n') : '(no memories)';
	const histSection = s.history.length ? s.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n') : '(no recent history)';
	return `INCOMING USER MESSAGE:\n${s.userText}\n\nRETRIEVED MEMORIES:\n${memSection}\n\nRECENT HISTORY:\n${histSection}\n\nProduce the JSON analysis.`;
};

const CURATOR_TASK = {
	id: 'curator',
	name: 'Response curator (JSON)',
	sys: CURATOR_SYS,
	maxOutputTokens: 800,
	useJsonMode: true,
	build: buildCurator,
	scenarios: [
		{ id: 'warm', label: 'emotional / warm', userText: "I just can't shake this. It's been three weeks and I still feel hollow.",
		  memories: [
			{ id: 11, category: 'pattern',    fact: 'Loneliness peaks on Sunday evenings.' },
			{ id: 12, category: 'episode',    fact: 'Last bereavement check-in was 2026-04-20.' },
			{ id: 13, category: 'preference', fact: 'Roman drinks pour-over coffee.' },
		  ],
		  history: [
			{ role: 'user', text: 'mood is rough today' },
			{ role: 'bot',  text: 'Noticed. Want to talk it through?' },
		  ]},
		{ id: 'technical', label: 'technical', userText: 'The fallback isn\'t firing on Pro 3.1 503s. Cascade walker is in handlers.js around line 1950.',
		  memories: [
			{ id: 21, category: 'project',    fact: 'Working on Xaridotis cascade fallback.' },
			{ id: 22, category: 'preference', fact: 'British English, no em dashes.' },
			{ id: 23, category: 'mood',       fact: 'Tired today.' },
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
			{ id: 41, category: 'trigger',    fact: 'Three days low scores -> escalate.' },
			{ id: 42, category: 'homework',   fact: 'If crisis signal, surface Samaritans.' },
			{ id: 43, category: 'preference', fact: 'Roman drinks pour-over coffee.' },
		  ],
		  history: [
			{ role: 'user', text: 'mood: 2/10' },
			{ role: 'bot',  text: "That's the third day in a row." },
		  ]},
		{ id: 'recall', label: 'recall request', userText: 'What did we land on for the curator latency issue last week?',
		  memories: [
			{ id: 51, category: 'project',    fact: 'Curator latency fix proposed: Hermes Tier 1 with cascade Tier 2+.' },
			{ id: 52, category: 'project',    fact: 'Roma decided to bench all models before re-architecting.' },
			{ id: 53, category: 'preference', fact: 'Metric units by default.' },
		  ],
		  history: []},
	],
	validate(output) {
		if (!output || typeof output !== 'string') return { parseOk: false, notes: 'no output' };
		const cleaned = output.replace(/```json|```/g, '').trim();
		let parsed = null;
		try { parsed = JSON.parse(cleaned); } catch {
			const m = cleaned.match(/\{[\s\S]*\}/);
			if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fail */ } }
		}
		if (!parsed) return { parseOk: false, notes: 'unparseable JSON' };
		const validRegs = ['casual','warm','technical','urgent'];
		const ok = validRegs.includes(parsed.register) && Array.isArray(parsed.flags) && Array.isArray(parsed.relevant_memory_ids) && typeof parsed.reasoning === 'string';
		return {
			parseOk: ok,
			parsedValue: { register: parsed.register, flags: parsed.flags, ids: parsed.relevant_memory_ids, reasoning: parsed.reasoning?.slice(0, 80) },
			notes: ok ? '' : 'JSON shape fail',
		};
	},
};

const TASKS = [
	MODE_TASK, TRIPLE_TASK, MOOD_TAG_TASK, DEDUP_TASK, STYLE_TASK,
	MOOD_SCORE_TASK, MOOD_EMO_TASK, SYNTHESIS_TASK, EVOLUTION_TASK, CURATOR_TASK,
];

// ============================================================================
// Runners
// ============================================================================

async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms); });
	try { return await Promise.race([promise, timeout]); }
	finally { clearTimeout(timer); }
}

async function runGemini(modelEntry, task, scenario) {
	const input = task.build(scenario);
	const config = {
		systemInstruction: task.sys,
		temperature: TEMPERATURE,
		maxOutputTokens: task.maxOutputTokens,
	};
	if (task.useJsonMode) config.responseMimeType = 'application/json';
	if (modelEntry.opts?.thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget: modelEntry.opts.thinkingBudget };
	else if (modelEntry.opts?.thinkingLevel !== undefined) config.thinkingConfig = { thinkingLevel: modelEntry.opts.thinkingLevel };

	const start = Date.now();
	try {
		const res = await withTimeout(geminiClient.models.generateContent({
			model: modelEntry.model,
			contents: [{ role: 'user', parts: [{ text: input }] }],
			config,
		}), HARD_TIMEOUT_MS, modelEntry.label);
		return { ok: true, latency: Date.now() - start, output: (res.text || '').trim() };
	} catch (err) {
		return { ok: false, latency: Date.now() - start, output: '', error: (err?.message || String(err)).slice(0, 300) };
	}
}

async function runCloudflare(modelEntry, task, scenario) {
	const input = task.build(scenario);
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${modelEntry.model}`;
	const body = {
		messages: [{ role: 'system', content: task.sys }, { role: 'user', content: input }],
		max_tokens: task.maxOutputTokens,
		temperature: TEMPERATURE,
	};
	if (task.useJsonMode) body.response_format = { type: 'json_object' };

	const start = Date.now();
	try {
		const res = await withTimeout(fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}), HARD_TIMEOUT_MS, modelEntry.label);
		const latency = Date.now() - start;
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, latency, output: '', error: `${res.status} ${text.slice(0, 200)}` };
		}
		const json = await res.json();
		if (!json.success) return { ok: false, latency, output: '', error: `cf:!success ${JSON.stringify(json.errors || {}).slice(0, 200)}` };
		let output = '';
		if (typeof json.result === 'string') output = json.result;
		else if (json.result?.response) output = json.result.response;
		else if (json.result?.text) output = json.result.text;
		else output = JSON.stringify(json.result || {});
		return { ok: true, latency, output: output.trim() };
	} catch (err) {
		return { ok: false, latency: Date.now() - start, output: '', error: (err?.message || String(err)).slice(0, 300) };
	}
}

async function runTrial(modelEntry, task, scenario, iteration) {
	const runner = modelEntry.kind === 'gemini' ? runGemini : runCloudflare;
	const r = await runner(modelEntry, task, scenario);
	let parseOk = false, parsedValue = null, notes = '';
	if (r.ok) {
		try {
			const v = task.validate(r.output, scenario);
			parseOk = v.parseOk; parsedValue = v.parsedValue; notes = v.notes || '';
		} catch (e) { notes = `validator threw: ${e.message}`; }
	}
	return {
		model_id: modelEntry.id, model_label: modelEntry.label, model_kind: modelEntry.kind,
		task_id: task.id, scenario_id: scenario.id, scenario_label: scenario.label,
		iteration, latency_ms: r.latency, api_ok: r.ok, parse_ok: parseOk,
		output_chars: r.output.length, output_preview: r.output.replace(/\s+/g, ' ').slice(0, 200),
		parsed_value: parsedValue ? JSON.stringify(parsedValue).slice(0, 200) : '',
		validate_notes: notes, error: r.error || '',
	};
}

// ============================================================================
// Concurrency limiter
// ============================================================================

function pLimit(n) {
	const queue = []; let active = 0;
	const next = () => { active--; if (queue.length) queue.shift()(); };
	return (fn) => new Promise((resolveOuter, rejectOuter) => {
		const run = () => { active++; fn().then(resolveOuter, rejectOuter).finally(next); };
		if (active < n) run(); else queue.push(run);
	});
}

// ============================================================================
// Stats + report helpers
// ============================================================================

function percentile(arr, p) {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function statsFor(rows) {
	const lats = rows.map(r => r.latency_ms).filter(Number.isFinite);
	return {
		n: rows.length,
		api_ok_pct: rows.length ? (rows.filter(r => r.api_ok).length / rows.length * 100) : 0,
		parse_pct:  rows.length ? (rows.filter(r => r.parse_ok).length / rows.length * 100) : 0,
		p50: percentile(lats, 50), p95: percentile(lats, 95), p99: percentile(lats, 99),
		mean: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
	};
}

function csvEscape(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function rowsToCsv(rows) {
	if (!rows.length) return '';
	const headers = Object.keys(rows[0]);
	return [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
}

function buildMarkdown(rows, elapsedSec) {
	const lines = [];
	const stamp = new Date().toISOString();
	lines.push(`# Background-task benchmark`);
	lines.push('');
	lines.push(`Generated ${stamp} | ${rows.length} trials | ${elapsedSec.toFixed(0)}s wall`);
	lines.push(`Models: ${new Set(rows.map(r => r.model_id)).size} | Tasks: ${new Set(rows.map(r => r.task_id)).size} | Iterations: ${ITERATIONS}`);
	lines.push('');

	// Per-task rankings
	for (const task of TASKS) {
		const taskRows = rows.filter(r => r.task_id === task.id);
		if (!taskRows.length) continue;
		lines.push(`## Task: \`${task.id}\` — ${task.name}`);
		lines.push('');
		const byModel = new Map();
		for (const r of taskRows) { if (!byModel.has(r.model_id)) byModel.set(r.model_id, []); byModel.get(r.model_id).push(r); }
		const ranked = [...byModel.entries()].map(([id, rs]) => ({ id, label: rs[0].model_label, kind: rs[0].model_kind, ...statsFor(rs) }))
			.sort((a, b) => (b.parse_pct - a.parse_pct) || ((a.p95 ?? Infinity) - (b.p95 ?? Infinity)));
		lines.push('| Rank | Model | Kind | Parse % | API % | P50 ms | P95 ms | P99 ms | N |');
		lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|');
		ranked.forEach((m, i) => {
			lines.push(`| ${i + 1} | ${m.label} | ${m.kind} | ${m.parse_pct.toFixed(0)} | ${m.api_ok_pct.toFixed(0)} | ${m.p50 ?? '-'} | ${m.p95 ?? '-'} | ${m.p99 ?? '-'} | ${m.n} |`);
		});
		lines.push('');
	}

	// Per-model overview
	lines.push('## Per-model overview (all tasks combined)');
	lines.push('');
	const byModel = new Map();
	for (const r of rows) { if (!byModel.has(r.model_id)) byModel.set(r.model_id, []); byModel.get(r.model_id).push(r); }
	const overall = [...byModel.entries()].map(([id, rs]) => ({ id, label: rs[0].model_label, kind: rs[0].model_kind, ...statsFor(rs) }))
		.sort((a, b) => (b.parse_pct - a.parse_pct) || ((a.p95 ?? Infinity) - (b.p95 ?? Infinity)));
	lines.push('| Rank | Model | Kind | Parse % | API % | P50 ms | P95 ms | N |');
	lines.push('|---|---|---|---:|---:|---:|---:|---:|');
	overall.forEach((m, i) => {
		lines.push(`| ${i + 1} | ${m.label} | ${m.kind} | ${m.parse_pct.toFixed(0)} | ${m.api_ok_pct.toFixed(0)} | ${m.p50 ?? '-'} | ${m.p95 ?? '-'} | ${m.n} |`);
	});
	lines.push('');

	// Top 3 picks per task
	lines.push('## Top 3 candidates per task (parse % then P95 latency)');
	lines.push('');
	for (const task of TASKS) {
		const taskRows = rows.filter(r => r.task_id === task.id);
		if (!taskRows.length) continue;
		const byM = new Map();
		for (const r of taskRows) { if (!byM.has(r.model_id)) byM.set(r.model_id, []); byM.get(r.model_id).push(r); }
		const top3 = [...byM.entries()].map(([id, rs]) => ({ id, label: rs[0].model_label, ...statsFor(rs) }))
			.sort((a, b) => (b.parse_pct - a.parse_pct) || ((a.p95 ?? Infinity) - (b.p95 ?? Infinity))).slice(0, 3);
		lines.push(`- **${task.id}**: ${top3.map(r => `${r.label} (${r.parse_pct.toFixed(0)}%/p95=${r.p95}ms)`).join(' · ')}`);
	}
	lines.push('');

	return lines.join('\n');
}

// ============================================================================
// Orchestrator
// ============================================================================

const totalTrials = MODELS.length * TASKS.length * 5 * ITERATIONS;
console.log(`Models: ${MODELS.length}, Tasks: ${TASKS.length}, Scenarios per task: 5, Iterations: ${ITERATIONS}`);
console.log(`Total trials: ${totalTrials}`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log('');

const limit = pLimit(CONCURRENCY);
const results = [];
let completed = 0;
const t0 = Date.now();

const queue = [];
for (const m of MODELS) {
	for (const t of TASKS) {
		for (const s of t.scenarios) {
			for (let i = 1; i <= ITERATIONS; i++) {
				queue.push({ m, t, s, i });
			}
		}
	}
}

const promises = queue.map(({ m, t, s, i }) => limit(async () => {
	const r = await runTrial(m, t, s, i);
	results.push(r);
	completed++;
	if (completed % 50 === 0 || completed === totalTrials) {
		const elapsed = ((Date.now() - t0) / 1000);
		const rate = completed / elapsed;
		const eta = (totalTrials - completed) / rate;
		console.log(`[${completed}/${totalTrials}] ${elapsed.toFixed(0)}s elapsed, ${rate.toFixed(2)}/s, eta ${eta.toFixed(0)}s — last: ${r.model_label}/${r.task_id}/${r.scenario_id}#${r.iteration} ${r.api_ok ? (r.parse_ok ? 'OK' : 'parse-fail') : 'API-FAIL'} ${r.latency_ms}ms`);
	}
}));

await Promise.all(promises);

// Sort for stable output
results.sort((a, b) => {
	if (a.task_id !== b.task_id) return a.task_id.localeCompare(b.task_id);
	if (a.model_id !== b.model_id) return a.model_id.localeCompare(b.model_id);
	if (a.scenario_id !== b.scenario_id) return a.scenario_id.localeCompare(b.scenario_id);
	return a.iteration - b.iteration;
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const mdPath  = `./bg_task_bench_${stamp}.md`;
const csvPath = `./bg_task_bench_${stamp}.csv`;
const elapsedSec = (Date.now() - t0) / 1000;

writeFileSync(mdPath,  buildMarkdown(results, elapsedSec), 'utf8');
writeFileSync(csvPath, rowsToCsv(results), 'utf8');

console.log('');
console.log(`Done. ${results.length} trials in ${elapsedSec.toFixed(1)}s.`);
console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${csvPath}`);
