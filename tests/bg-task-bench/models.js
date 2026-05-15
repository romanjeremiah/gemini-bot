// Model registry for the background-task benchmark.
//
// 25 models total: 16 Cloudflare Workers AI + 9 Gemini variants.
// Each entry: { id, kind, model, opts?, label }
//   - kind: 'gemini' or 'cf'
//   - opts: thinkingBudget / thinkingLevel / responseMimeType passed to the runner
//   - label: stable short string for tables (no spaces)
//
// Last updated 2026-05-15 — cross-referenced against the live CF catalogue at
// https://developers.cloudflare.com/ai/models/. Excludes models marked
// "Planned deprecation" (Hermes, Kimi K2.5, Llama 3.1 8B base, Llama 3 / 3-AWQ,
// Gemma 3 12B, Phi-2, Mistral v0.1, etc.).

export const MODELS = [
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
	{ id: 'gem:flash-3',            kind: 'gemini', model: 'gemini-3-flash-preview',         label: 'gemini-3-flash' },
	{ id: 'gem:3.1-fl',             kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  label: 'gemini-3.1-fl' },
	{ id: 'gem:3.1-fl-min',         kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'minimal' }, label: 'gemini-3.1-fl-min' },
	{ id: 'gem:3.1-fl-med',         kind: 'gemini', model: 'gemini-3.1-flash-lite-preview',  opts: { thinkingLevel: 'medium' },  label: 'gemini-3.1-fl-med' },
	{ id: 'gem:2.5-fl-dyn',         kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: -1 },       label: 'gemini-2.5-fl-dyn' },
	{ id: 'gem:2.5-fl-b512',        kind: 'gemini', model: 'gemini-2.5-flash-lite',          opts: { thinkingBudget: 512 },      label: 'gemini-2.5-fl-b512' },
	{ id: 'gem:2.5-pro-dyn',        kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: -1 },       label: 'gemini-2.5-pro-dyn' },
	{ id: 'gem:2.5-pro-b128',       kind: 'gemini', model: 'gemini-2.5-pro',                 opts: { thinkingBudget: 128 },      label: 'gemini-2.5-pro-b128' },
	{ id: 'gem:3.1-pro',            kind: 'gemini', model: 'gemini-3.1-pro-preview',         label: 'gemini-3.1-pro' },
];
