// Canonical mood poll options used by BOTH the scheduled evening check-in
// (src/index.js handleHealthCheckIns) and the manual /mood command (src/bot/handlers.js).
// Historically these drifted apart with the manual version truncated. Both now
// import from here to prevent that. Matches the clinical bipolar scale described
// in MENTAL_HEALTH_DIRECTIVE section 2 (see src/config/personas.js).
//
// Telegram Bot API limits poll option text to 100 characters; longest entry here
// is ~60 chars, well within the limit.

export const MOOD_POLL_OPTIONS = [
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
