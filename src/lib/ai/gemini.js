import { GoogleGenAI } from '@google/genai';
import { toolDefinitions } from '../../tools/index.js';

// Architecture B+ Revision (2026-05-14) — model selection rewritten per Roma's
// explicit cascade spec after the live-test failures (524 crash on emotional
// reply, short/hallucinating synthesis, slow short acks).
//
// Conversational lanes (driven by router → handlers.js):
//   Main conversational chat: Flash 3 → 3.1 FL → 2.5 FL dyn → Pro 3.1 medium → Kimi → Gemma
//   Single-turn utility:      Flash 3 → 3.1 FL → 2.5 FL dyn → Pro 3.1 medium → Kimi → Gemma
//   Tagger / transactional:   Gemma → 3.1 FL → Flash 3 → Pro 3.1 medium
//   Crisis / mental health:   Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro dyn → Kimi
//   Multi-turn continuity:    Flash 3 → 3.1 FL → 2.5 Pro dyn → Kimi → Pro 3.1 default
//   Complex synthesis:        Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro dyn → Kimi
//   Code / analytical:        Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro dyn → Kimi
//   Deep therapeutic (cron):  Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro b128 → 2.5 FL b512
//   Short responses:          Gemma → Flash 3 → 3.1 FL
//   Cron / background:        Flash 3 → 3.1 FL → Kimi → 2.5 Pro b128
//   Routing classifier:       3.1 FL minimal (Arch B only)
//   Images:                   unchanged (3 Pro Image → 3.1 Flash Image)
//
// Model constants below mirror these chains. Helpers `runConversationalCascade`,
// `runCrisisCascade`, `runDeepCascade`, `runShortCascade`, `runBackgroundCascade`
// implement the sequential fallback chains for non-streaming callers.
// Streaming (handlers.js) walks the main-convo cascade tier-by-tier on its own.

// ---- Model identifiers ----
export const FLASH_3_MODEL       = 'gemini-3-flash-preview';
export const FLASH_LITE_31_MODEL = 'gemini-3.1-flash-lite-preview';
export const FLASH_LITE_25_MODEL = 'gemini-2.5-flash-lite';
export const PRO_31_MODEL        = 'gemini-3.1-pro-preview';
export const PRO_25_MODEL        = 'gemini-2.5-pro';
export const KIMI_MODEL          = '@cf/moonshotai/kimi-k2.6';
export const GEMMA_MODEL         = '@cf/google/gemma-4-26b-a4b-it';

// Legacy aliases kept so existing callers in handlers.js / responseCurator /
// transcription / mood files continue to compile without restructuring.
// PRIMARY = main convo Tier 1 (Flash 3). FALLBACK = main convo Tier 2 (3.1 FL).
// FLASH_LITE_TEXT_MODEL = 3.1 FL (used by transcription fallback + curator + handlers.js model menu).
export const PRIMARY_TEXT_MODEL    = FLASH_3_MODEL;
export const FALLBACK_TEXT_MODEL   = FLASH_LITE_31_MODEL;
export const FLASH_LITE_TEXT_MODEL = FLASH_LITE_31_MODEL;
export const DEEP_RESPONSE_MODEL   = PRO_31_MODEL; // deep cron synthesis Tier 1

const PRIMARY_IMAGE_MODEL  = 'gemini-3-pro-image-preview';
const FALLBACK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

// Default thinking config for the main conversational lane (Flash 3 has no
// thinking budget knob; this is the default applied to 2.5 GA tiers and to
// Pro 3.1 medium when used as a fallback tier).
const DEFAULT_THINKING_BUDGET = -1;

const CACHE_TTL = '3600s';
const MIN_CACHE_TOKENS_GEMINI3 = 4096;
const CHARS_PER_TOKEN = 4;

let _ai = null;

function getAI(env) {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return _ai;
}

function normalizeSchema(obj) {
  if (Array.isArray(obj)) return obj.map(normalizeSchema);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = key === 'type' && typeof value === 'string'
        ? value.toLowerCase()
        : normalizeSchema(value);
    }
    return result;
  }
  return obj;
}

const normalizedTools = normalizeSchema(toolDefinitions);

async function withRetry(fn, maxRetries = 3, fallbackFn = null) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || '';
      const isRetryable = msg.includes('503') || msg.includes('429')
        || err?.status === 503 || err?.status === 429;
      if (!isRetryable) throw err;
      lastError = err;

      const serverWaitMs = parseRetryAfter(err);
      const expoMs = Math.pow(2, i) * 1000;
      const wait = Math.min(
        Math.max(serverWaitMs ?? expoMs, expoMs),
        30_000,
      );
      const reason = serverWaitMs ? `server retry-after ${serverWaitMs}ms` : `expo backoff ${expoMs}ms`;
      console.log(`⏳ Gemini retry ${i + 1}/${maxRetries} in ${wait}ms (${reason})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (fallbackFn) {
    console.log(`🔄 Primary exhausted — switching to fallback model`);
    return await fallbackFn();
  }
  throw lastError;
}

function parseRetryAfter(err) {
  if (!err) return null;
  if (typeof err.retryAfter === 'number' && err.retryAfter > 0) {
    return Math.min(err.retryAfter * 1000, 30_000);
  }
  const header = err.headers?.['retry-after'] || err.headers?.['Retry-After'];
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 30_000);
  }
  const m = (err.message || '').match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (m) {
    const ms = Math.round(parseFloat(m[1]) * 1000);
    if (ms > 0) return Math.min(ms, 30_000);
  }
  return null;
}

/**
 * Generate content with automatic Primary → Fallback chain.
 * 2-tier; used by some legacy call sites. For new code prefer
 * runBackgroundCascade / runDeepCascade / runCrisisCascade.
 */
export async function generateWithFallback(env, contents, config = {}) {
  const ai = getAI(env);

  const primaryConfig = withThinkingDefaults(config, { thinkingBudget: DEFAULT_THINKING_BUDGET });
  const fallbackConfig = withThinkingDefaults(config, { thinkingBudget: DEFAULT_THINKING_BUDGET });

  const doGenerate = (model, cfg) => ai.models.generateContent({
    model, contents, config: cfg
  });

  const response = await withRetry(
    () => doGenerate(PRIMARY_TEXT_MODEL, primaryConfig),
    2,
    () => doGenerate(FALLBACK_TEXT_MODEL, fallbackConfig)
  );

  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';

  return { text: text.trim(), response };
}

function withThinkingDefaults(baseConfig, defaults) {
  const out = { ...baseConfig };
  if (out.thinkingConfig) return out;
  if (typeof defaults.thinkingBudget === 'number') {
    out.thinkingConfig = { thinkingBudget: defaults.thinkingBudget };
  } else if (defaults.thinkingLevel) {
    out.thinkingConfig = { thinkingLevel: defaults.thinkingLevel };
  }
  return out;
}

// ---- Context Caching ----
const _cacheNames = new Map();

async function getOrCreateCache(personaInstruction, formattingRules, mentalHealthDirective, env, model = PRIMARY_TEXT_MODEL) {
  const cacheKey = `gemini_cache_${model}_${hashStr(personaInstruction + (mentalHealthDirective || '')).slice(0, 16)}`;

  if (_cacheNames.has(cacheKey)) {
    try {
      await getAI(env).caches.get({ name: _cacheNames.get(cacheKey) });
      return _cacheNames.get(cacheKey);
    } catch {
      console.log('🗑️ In-memory cache expired, clearing...');
      _cacheNames.delete(cacheKey);
    }
  }

  const kvCacheName = await env.CHAT_KV.get(cacheKey);
  if (kvCacheName) {
    try {
      await getAI(env).caches.get({ name: kvCacheName });
      _cacheNames.set(cacheKey, kvCacheName);
      return kvCacheName;
    } catch {
      console.log('🗑️ KV cache expired on Google side, recreating...');
      await env.CHAT_KV.delete(cacheKey);
    }
  }

  const clinicalBlock = mentalHealthDirective ? `\n${mentalHealthDirective}` : '';
  const staticContent = `${personaInstruction}\n${formattingRules}${clinicalBlock}`;
  const estimatedTokens = Math.ceil(staticContent.length / CHARS_PER_TOKEN);
  const toolsJson = JSON.stringify(normalizedTools);
  const estimatedToolTokens = Math.ceil(toolsJson.length / CHARS_PER_TOKEN);
  const totalEstimatedTokens = estimatedTokens + estimatedToolTokens;

  if (totalEstimatedTokens < MIN_CACHE_TOKENS_GEMINI3) {
    console.log(`📦 Skipping cache: ~${totalEstimatedTokens} tokens < ${MIN_CACHE_TOKENS_GEMINI3} minimum for ${model}`);
    return null;
  }

  try {
    console.log(`🧊 Creating cache (~${totalEstimatedTokens} estimated tokens) for ${model}...`);
    const cache = await getAI(env).caches.create({
      model,
      config: {
        systemInstruction: staticContent,
        tools: [{ functionDeclarations: normalizedTools }, { googleSearch: {} }],
        toolConfig: { includeServerSideToolInvocations: true },
        ttl: CACHE_TTL,
        displayName: cacheKey,
      }
    });
    const cacheName = cache.name;
    const actualTokens = cache.usageMetadata?.totalTokenCount || '?';
    console.log(`🧊 Cache created: ${cacheName} (${actualTokens} tokens, TTL: ${CACHE_TTL})`);
    await env.CHAT_KV.put(cacheKey, cacheName, { expirationTtl: 3000 });
    _cacheNames.set(cacheKey, cacheName);
    return cacheName;
  } catch (err) {
    console.error(`⚠️ Cache creation failed for ${model}: ${err.message}`);
    return null;
  }
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function buildConfig(systemInstruction, opts = {}) {
  const tools = [{ functionDeclarations: normalizedTools }, { googleSearch: {} }];

  const config = {
    systemInstruction,
    tools,
    toolConfig: { includeServerSideToolInvocations: true },
    temperature: 1.0,
  };

  config.thinkingConfig = resolveThinkingConfig(opts, { thinkingBudget: DEFAULT_THINKING_BUDGET });
  // Drop thinkingConfig entirely when undefined (Flash 3 / Pro 3.1 default don't take it).
  if (!config.thinkingConfig) delete config.thinkingConfig;

  return config;
}

function buildCachedConfig(cacheName, opts = {}) {
  const config = {
    cachedContent: cacheName,
    temperature: 1.0,
  };

  config.thinkingConfig = resolveThinkingConfig(opts, { thinkingBudget: DEFAULT_THINKING_BUDGET });
  if (!config.thinkingConfig) delete config.thinkingConfig;

  return config;
}

function resolveThinkingConfig(opts, fallback) {
  if (typeof opts.thinkingBudget === 'number') {
    return { thinkingBudget: opts.thinkingBudget };
  }
  if (opts.thinkingLevel) {
    return { thinkingLevel: opts.thinkingLevel };
  }
  if (typeof fallback.thinkingBudget === 'number') {
    return { thinkingBudget: fallback.thinkingBudget };
  }
  if (fallback.thinkingLevel) {
    return { thinkingLevel: fallback.thinkingLevel };
  }
  return undefined;
}

export async function createChat(history, systemInstruction, env, cacheContext = null, model = null, opts = {}) {
  const useModel = model || PRIMARY_TEXT_MODEL;
  const config = cacheContext?.cacheName
    ? buildCachedConfig(cacheContext.cacheName, opts)
    : buildConfig(systemInstruction, opts);

  console.log(`🤖 Model: ${useModel}`);
  return getAI(env).chats.create({
    model: useModel,
    config,
    history: history || [],
  });
}

export async function setupCache(personaInstruction, formattingRules, dynamicContext, env, model = PRIMARY_TEXT_MODEL, mentalHealthDirective = null) {
  const cacheName = await getOrCreateCache(personaInstruction, formattingRules, mentalHealthDirective, env, model);
  if (!cacheName) return null;
  return { cacheName, dynamicPrefix: dynamicContext };
}

// ---- Non-streaming chat send ----
export async function* sendChatMessage(chat, message, opts = {}) {
  const maxRetries = opts.fastFail ? 1 : 3;
  const response = await withRetry(
    () => chat.sendMessage({ message }),
    maxRetries, null
  );
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.text && !part.thought) yield { type: 'text', text: part.text };
  }
  const calls = parts.filter(p => p.functionCall && p.functionCall.name !== 'googleSearch');
  if (calls.length) yield { type: 'functionCall', calls };
  const gm = response.candidates?.[0]?.groundingMetadata;
  if (gm) yield { type: 'groundingMetadata', metadata: gm };
}

// ---- True streaming ----
const STREAM_IDLE_MS = 25000;

export class StreamIdleError extends Error {
  constructor(idleMs) {
    super(`STREAM_IDLE: no chunk received for ${idleMs}ms`);
    this.name = 'StreamIdleError';
    this.code = 'STREAM_IDLE';
    this.idleMs = idleMs;
  }
}

export async function* sendChatMessageStream(chat, message) {
  let stream;
  try {
    stream = await chat.sendMessageStream({ message });
  } catch (err) {
    console.warn('⚠️ Stream open failed:', err.status || '', err.message);
    yield* sendChatMessage(chat, message, { fastFail: true });
    return;
  }

  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    let idleTimer;
    const idlePromise = new Promise((_, reject) => {
      idleTimer = setTimeout(() => reject(new StreamIdleError(STREAM_IDLE_MS)), STREAM_IDLE_MS);
    });

    let result;
    try {
      result = await Promise.race([iterator.next(), idlePromise]);
    } finally {
      clearTimeout(idleTimer);
    }

    if (result.done) return;
    const chunk = result.value;

    const parts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.text && !part.thought) yield { type: 'text', text: part.text };
    }
    const calls = parts.filter(p => p.functionCall && p.functionCall.name !== 'googleSearch');
    if (calls.length) yield { type: 'functionCall', calls };

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      yield { type: 'finishReason', reason: candidate.finishReason };
    }
    const pf = chunk.promptFeedback;
    if (pf?.blockReason) yield { type: 'blockReason', reason: pf.blockReason };

    const gm = candidate?.groundingMetadata;
    if (gm) yield { type: 'groundingMetadata', metadata: gm };
  }
}

export async function generateImage(prompt, env, inputImageBase64 = null, inputMimeType = null, useFallback = false) {
  const isEditing = !!(inputImageBase64 && inputMimeType);
  const model = useFallback ? FALLBACK_IMAGE_MODEL : PRIMARY_IMAGE_MODEL;
  const parts = [];
  if (isEditing) {
    parts.push({ inlineData: { mimeType: inputMimeType, data: inputImageBase64 } });
  }
  parts.push({ text: prompt });
  console.log(`🎨 Image ${isEditing ? 'edit' : 'gen'} → ${model}`);
  const doGenerate = (m) => getAI(env).models.generateContent({
    model: m, contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  const response = await withRetry(
    () => doGenerate(model), 3,
    !useFallback ? () => doGenerate(FALLBACK_IMAGE_MODEL) : null
  );
  const candidate = response.candidates?.[0];
  if (!candidate) {
    const blockReason = response.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Blocked: ${blockReason}` : 'Image generation returned no result');
  }
  if (candidate.finishReason === 'SAFETY') throw new Error('Image blocked by safety filters');
  let imageBase64 = null, mimeType = null, caption = '';
  for (const part of candidate.content?.parts || []) {
    if (part.inlineData) { imageBase64 = part.inlineData.data; mimeType = part.inlineData.mimeType || 'image/png'; }
    else if (part.text) caption += part.text;
  }
  if (!imageBase64) throw new Error('No image was generated. Try a different prompt.');
  console.log(`🎨 Image ready — mime: ${mimeType}, size: ${imageBase64.length}`);
  return { imageBase64, mimeType, caption };
}


// ============================================================================
//  CASCADE PRIMITIVES — sequential fallback chain helpers
// ============================================================================
//
// Each tier is { kind: 'gemini'|'cf', model: string, opts?: object, label: string }.
// runCascade walks tiers in order, returning the first non-empty text.
// kind='gemini' uses the Gemini SDK with optional thinkingBudget/thinkingLevel.
// kind='cf' uses Cloudflare AI (env.AI) — for Kimi and Gemma tiers.

async function _runGeminiTier(env, model, prompt, systemPrompt, opts, label) {
  if (!env.GEMINI_API_KEY) return null;
  const t0 = Date.now();
  try {
    const thinkingConfig = resolveThinkingConfig(opts || {}, { thinkingBudget: DEFAULT_THINKING_BUDGET });
    const config = {
      systemInstruction: systemPrompt || undefined,
      temperature: 1.0,
      maxOutputTokens: opts?.maxOutputTokens ?? 2000,
    };
    if (thinkingConfig) config.thinkingConfig = thinkingConfig;
    if (opts?.responseMimeType) config.responseMimeType = opts.responseMimeType;

    const response = await getAI(env).models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config,
    });
    let text = '';
    if (typeof response?.text === 'string') text = response.text;
    else if (typeof response?.text === 'function') {
      try { text = response.text() || ''; } catch { /* skip */ }
    }
    if (!text) {
      text = response?.candidates?.[0]?.content?.parts
        ?.filter((p) => p.text && !p.thought)
        ?.map((p) => p.text)
        ?.join('') || '';
    }
    const trimmed = (text || '').trim();
    if (!trimmed) {
      console.warn(`⚠️ ${label} (${model}) returned empty in ${Date.now() - t0}ms`);
      return null;
    }
    console.log(`✅ ${label} (${model}) ok in ${Date.now() - t0}ms`);
    return trimmed;
  } catch (err) {
    console.warn(`⚠️ ${label} (${model}) failed in ${Date.now() - t0}ms: ${(err.message || '').slice(0, 200)}`);
    return null;
  }
}

async function _runCfTier(env, model, prompt, systemPrompt, opts, label) {
  if (!env.AI) return null;
  const t0 = Date.now();
  try {
    const { runCfAi } = await import('../ai-gateway');
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const result = await runCfAi(env.AI, model, {
      messages,
      max_tokens: opts?.maxOutputTokens ?? 2000,
      temperature: opts?.temperature ?? 1.0,
    }, { headers: { 'x-session-affinity': 'xaridotis-cascade' } });

    let text = '';
    if (typeof result === 'string') text = result;
    else if (typeof result?.response === 'string') text = result.response;
    else if (result?.choices?.[0]?.message?.content) text = result.choices[0].message.content;

    const trimmed = (text || '').trim();
    if (!trimmed) {
      console.warn(`⚠️ ${label} (${model}) returned empty in ${Date.now() - t0}ms`);
      return null;
    }
    console.log(`✅ ${label} (${model}) ok in ${Date.now() - t0}ms`);
    return trimmed;
  } catch (err) {
    console.warn(`⚠️ ${label} (${model}) failed in ${Date.now() - t0}ms: ${(err.message || '').slice(0, 200)}`);
    return null;
  }
}

/**
 * Walk a sequential cascade of model tiers. Returns the first non-empty text
 * from any tier, or null if every tier failed.
 *
 * @param {object} env
 * @param {string} prompt
 * @param {string} systemPrompt
 * @param {Array<{kind:'gemini'|'cf', model:string, opts?:object, label:string}>} tiers
 */
export async function runCascade(env, prompt, systemPrompt, tiers) {
  for (const tier of tiers) {
    const text = tier.kind === 'gemini'
      ? await _runGeminiTier(env, tier.model, prompt, systemPrompt, tier.opts, tier.label)
      : await _runCfTier(env, tier.model, prompt, systemPrompt, tier.opts, tier.label);
    if (text) return text;
  }
  return null;
}


// ============================================================================
//  SHORT-RESPONSE CASCADE — greetings, listen-mode, observations
// ============================================================================
// Chain (Roma 2026-05-14): Gemma → Flash 3 → 3.1 FL.

const SHORT_RESPONSE_GUIDE = '\n\nYou are generating a brief message for a Telegram bot. Keep it to 2-4 complete sentences. Be fully in character. No asterisks, no markdown, no HTML tags. You MUST finish every sentence completely. Never stop mid-sentence or mid-thought.';

const SHORT_RESPONSE_TIERS = [
  { kind: 'cf', model: GEMMA_MODEL, opts: { maxOutputTokens: 1000 }, label: 'short:gemma' },
  { kind: 'gemini', model: FLASH_3_MODEL, opts: { maxOutputTokens: 1000 }, label: 'short:flash-3' },
  { kind: 'gemini', model: FLASH_LITE_31_MODEL, opts: { maxOutputTokens: 1000, thinkingLevel: 'minimal' }, label: 'short:3.1-fl' },
];

export async function generateShortResponse(prompt, systemInstruction, env) {
  const fullSystem = `${systemInstruction}${SHORT_RESPONSE_GUIDE}`;
  const text = await runCascade(env, prompt, fullSystem, SHORT_RESPONSE_TIERS);
  if (!text) return '';
  return _trimTrailing(text);
}

function _trimTrailing(text) {
  text = (text || '').trim();
  if (text && !/[.!?…"']$/.test(text)) {
    const ends = ['. ', '! ', '? ', '.', '!', '?'].map(s => text.lastIndexOf(s)).filter(i => i > 0);
    if (ends.length) text = text.slice(0, Math.max(...ends) + 1).trim();
  }
  return text;
}


// ============================================================================
//  DEEP-RESPONSE CASCADE — cron synthesis, weekly reports, therapeutic notes
// ============================================================================
// Chain (Roma 2026-05-14): Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro b128 → 2.5 FL b512.

const DEEP_RESPONSE_TIERS = [
  { kind: 'gemini', model: PRO_31_MODEL,        opts: { maxOutputTokens: 2000 },                            label: 'deep:pro-3.1' },
  { kind: 'gemini', model: FLASH_3_MODEL,       opts: { maxOutputTokens: 2000 },                            label: 'deep:flash-3' },
  { kind: 'gemini', model: FLASH_LITE_31_MODEL, opts: { maxOutputTokens: 2000, thinkingLevel: 'medium' },   label: 'deep:3.1-fl' },
  { kind: 'gemini', model: PRO_25_MODEL,        opts: { maxOutputTokens: 2000, thinkingBudget: 128 },       label: 'deep:2.5-pro-b128' },
  { kind: 'gemini', model: FLASH_LITE_25_MODEL, opts: { maxOutputTokens: 2000, thinkingBudget: 512 },       label: 'deep:2.5-fl-b512' },
];

export async function generateDeepResponse(prompt, systemInstruction, env, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens || 2000;
  // Apply caller's maxOutputTokens to all tiers
  const tiers = DEEP_RESPONSE_TIERS.map(t => ({
    ...t,
    opts: { ...t.opts, maxOutputTokens },
  }));
  const text = await runCascade(env, prompt, systemInstruction, tiers);
  return text || '';
}


// ============================================================================
//  CRISIS CASCADE — emotional / mental health conversational replies
// ============================================================================
// Chain (Roma 2026-05-14): Pro 3.1 default → Flash 3 → 3.1 FL → 2.5 Pro dyn → Kimi.

const CRISIS_TIERS = [
  { kind: 'gemini', model: PRO_31_MODEL,        opts: { maxOutputTokens: 2000 },                          label: 'crisis:pro-3.1' },
  { kind: 'gemini', model: FLASH_3_MODEL,       opts: { maxOutputTokens: 2000 },                          label: 'crisis:flash-3' },
  { kind: 'gemini', model: FLASH_LITE_31_MODEL, opts: { maxOutputTokens: 2000 },                          label: 'crisis:3.1-fl' },
  { kind: 'gemini', model: PRO_25_MODEL,        opts: { maxOutputTokens: 2000, thinkingBudget: -1 },      label: 'crisis:2.5-pro-dyn' },
  { kind: 'cf',     model: KIMI_MODEL,          opts: { maxOutputTokens: 2000 },                          label: 'crisis:kimi' },
];

export async function generateCrisisResponse(prompt, systemInstruction, env, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens || 2000;
  const tiers = CRISIS_TIERS.map(t => ({ ...t, opts: { ...t.opts, maxOutputTokens } }));
  const text = await runCascade(env, prompt, systemInstruction, tiers);
  return text || '';
}


// ============================================================================
//  BACKGROUND CASCADE — generic helper for background tasks
// ============================================================================
// Chain (Roma 2026-05-14): Flash 3 → 3.1 FL → Kimi → 2.5 Pro b128.
// Callers in cfAi.js / personaEvolution.js / etc. pass their own tier arrays
// for task-specific chains; this default is for cases where they don't.

const BACKGROUND_TIERS = [
  { kind: 'gemini', model: FLASH_3_MODEL,       opts: { maxOutputTokens: 2000 },                       label: 'bg:flash-3' },
  { kind: 'gemini', model: FLASH_LITE_31_MODEL, opts: { maxOutputTokens: 2000 },                       label: 'bg:3.1-fl' },
  { kind: 'cf',     model: KIMI_MODEL,          opts: { maxOutputTokens: 2000 },                       label: 'bg:kimi' },
  { kind: 'gemini', model: PRO_25_MODEL,        opts: { maxOutputTokens: 2000, thinkingBudget: 128 },  label: 'bg:2.5-pro-b128' },
];

export async function runBackgroundCascade(env, prompt, systemPrompt, customTiers = null) {
  const tiers = customTiers || BACKGROUND_TIERS;
  return runCascade(env, prompt, systemPrompt, tiers);
}


// ============================================================================
//  BACKGROUND GENERATE — single-model Gemini helper (kept for compat)
// ============================================================================
// Used by cfAi.js for single-model background calls. Returns trimmed text or
// null on failure. Callers that want cascades should use runCascade directly.
export async function geminiBackgroundGenerate(env, model, prompt, systemPrompt = '', opts = {}) {
  return _runGeminiTier(env, model, prompt, systemPrompt, opts, `bg:${model}`);
}
