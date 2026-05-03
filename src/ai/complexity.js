// Complexity heuristics for the routing layer.
//
// Lives here (not in handlers.js) so router.js can import them without
// creating a circular dependency. handlers.js and index.js both import
// from this module via the re-export in handlers.js (for backward compat)
// or directly from here (preferred).
//
// detectComplexTask: returns true if the message warrants Gemini Pro.
//   - Code / architecture keywords
//   - Mental health / emotional keywords
//   - Analytical / research triggers
//   - Long messages (>300 chars)
//
// isSimpleMessage: returns true if Flash-Lite is sufficient.
//   - Short / casual chat
//   - Acknowledgments and confirmations
//   - Data point reports (sleep, meds, mood)
//
// detectComplexTask wins over isSimpleMessage when both could match.
// Both functions are pure — same input always returns same output.

/**
 * Returns true if the message requires Pro-level reasoning.
 */
export function detectComplexTask(text) {
	if (!text) return false;

	// Code / architecture
	if (/\b(code|function|bug|error|deploy|refactor|implement|architecture|PR|pull request|commit|git|webpack|npm|wrangler|api|endpoint|database|query|sql|schema|migration)\b/i.test(text)) return true;
	if (/\.(js|ts|py|json|css|html|jsx|mjs)\b/.test(text)) return true;
	if (/```/.test(text)) return true;

	// Mental health / emotional depth
	if (/\b(anxious|depressed|panic|overwhelm|trigger|dissociat|suicid|self.?harm|therapy|therapist|schema|attachment|ifs|dbt|aedp|emotion|mood|bipolar|mania|hypo)\b/i.test(text)) return true;

	// Complex analytical requests
	if (/\b(analyse|analyze|compare|explain.*detail|deep dive|break down|pros and cons|trade.?off|strategy|plan)\b/i.test(text)) return true;

	// Research triggers (doing, not viewing)
	if (/\b(research|investigate|look into)\b/i.test(text) && !/\b(show|list|recent|history|results|previous|past|full report)\b/i.test(text)) return true;

	// Long messages
	if (text.length > 300) return true;

	return false;
}

/**
 * Returns true if the message is simple enough for Flash-Lite.
 * Runs AFTER detectComplexTask in the router — complex always wins.
 */
export function isSimpleMessage(text) {
	if (!text) return true; // empty/media-only — caller decides via hasMedia rule
	const trimmed = text.trim();

	// Very short: always simple
	if (trimmed.length < 30) return true;

	// Acknowledgments, confirmations, reactions
	if (/^(ok|okay|yes|yep|yeah|no|nope|nah|thanks|ty|cool|nice|sure|done|sound|sounds good|got it|right|alright|cheers|k|kk)\b/i.test(trimmed)) return true;

	// Data point reports (sleep hours, meds, quick mood notes)
	if (/^(slept|sleep|meds|medication|took|had|feeling|mood)\b/i.test(trimmed) && trimmed.length < 80) return true;

	// Short statements without questions (conversational flow, not substantive query)
	if (!/[?]/.test(trimmed) && trimmed.length < 60) return true;

	return false;
}
