// Central model registry — Cloudflare Workers AI + Gemini.
//
// Imported by src/ai/router.js. Single source of truth for which model
// strings the bot uses, so swapping a model is a one-line change here
// rather than a search-replace across the codebase.
//
// Cost notes:
//   - Gemini Pro: $2/$12 per 1M tokens (input/output)
//   - Gemini Flash: $0.50/$3 per 1M
//   - Gemini Flash-Lite: $0.25/$1.50 per 1M
//   - Workers AI: priced in Neurons (~$0.011/1K). Gemma 4 26B costs more per
//     call than the docs imply once you include the input/output Neuron
//     conversion — not free, but cheaper than Gemini Pro for casual chat.
//     Verify your actual bill weekly until volume is well understood.

/** Cloudflare Workers AI models — primary path for casual chat & background work */
export const CF_MODELS = Object.freeze({
	chat:        '@cf/google/gemma-4-26b-a4b-it',     // default for ALL CF-routed chat
	observation: '@cf/meta/llama-3.1-8b-instruct',    // background fact extraction
	tagging:     '@cf/meta/llama-3.2-1b-instruct',    // sentiment, light tagging
	dedup:       '@cf/zai-org/glm-4.7-flash',         // long-text summarisation, consolidation
	embedding:   '@cf/baai/bge-base-en-v1.5',         // 768-dim, matches Gemini fallback
	reranker:    '@cf/baai/bge-reranker-base',        // already wired in vectorStore.js
});

/** Gemini models — reserved for emotional, multimodal, and complex paths */
export const GEMINI_MODELS = Object.freeze({
	pro:        'gemini-3.1-pro-preview',
	flash:      'gemini-3-flash-preview',
	flashLite:  'gemini-3.1-flash-lite-preview',
	imagePro:   'gemini-3-pro-image-preview',         // Nano Banana Pro
	imageFlash: 'gemini-3.1-flash-image-preview',     // Nano Banana 2
	tts:        'gemini-2.5-pro-preview-tts',
	embedding:  'gemini-embedding-2-preview',         // 768-dim via outputDimensionality
});

/** Complexity detection patterns — used by router.js to score messages. */
export const COMPLEXITY_PATTERNS = Object.freeze({
	// Code/architecture: route to Qwen3 (free, strong reasoning)
	code: /\b(code|debug|function|class|api|typescript|javascript|python|regex|algorithm|sql|css|html|deploy|refactor|error|bug|fix|webpack|npm|wrangler|endpoint|database|query|schema|migration|github|commit|pr|pull request)\b/i,

	// Analytical / research: route to Qwen3
	analytical: /\b(compare|analyse|analyze|evaluate|research|explain.*detail|deep dive|break down|pros and cons|trade.?off|strategy|plan|estimate|statistics|review|investigate)\b/i,

	// Emotional / therapeutic: route to Gemini Pro for therapeutic depth
	emotional: /\b(anxious|depressed|panic|overwhelm|scared|lonely|empty|hopeless|angry|frustrated|sad|grief|trigger|manic|racing|numb|crying|breakdown|struggling|worried|stressed|dissociat|suicid|self.?harm|therapy|therapist|schema|attachment|ifs|dbt|aedp|emotion|mood|bipolar|mania|hypo)\b/i,
});

/** Tool-loop bound. Same as Eukara — protects against runaway tool chains. */
export const MAX_TOOL_ROUNDS = 5;
