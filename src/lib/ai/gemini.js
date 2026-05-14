import { GoogleGenAI } from '@google/genai';
import { toolDefinitions } from '../../tools/index.js';

// Architecture B+ (2026-05-14) — model selection after combined-evaluation
// bundle showed 2.5 Flash-Lite GA at the top of the Gemini family (73.5/108)
// and 3.1 Pro preview unusable (0/108). Primary conversational lane now
// runs on 2.5 Flash-Lite GA dynamic for routine turns; crisis turns race
// 2.5 Pro budget 128 against 2.5 Flash-Lite budget 512 via
// generateCrisisResponse. Cron/deep work uses 2.5 Pro budget 128.
export const PRIMARY_TEXT_MODEL    = 'gemini-2.5-flash-lite';
export const FALLBACK_TEXT_MODEL   = 'gemini-2.5-flash';
export const DEEP_RESPONSE_MODEL   = 'gemini-2.5-pro';
export const FLASH_LITE_TEXT_MODEL = 'gemini-3.1-flash-lite-preview'; // preview tier — used as transcription fallback, NOT for text generation
const PRIMARY_IMAGE_MODEL  = 'gemini-3-pro-image-preview';     // Nano Banana Pro — best quality gen + edit
const FALLBACK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'; // Nano Banana 2 — fast fallback

// Default thinking configurations per lane. -1 means dynamic on 2.5 GA.
const DEFAULT_THINKING_BUDGET   = -1;  // main conversational path: 2.5 FL dynamic (73.0/108 in bundle)
const CRISIS_PRO_BUDGET         = 128; // 2.5 Pro at budget 128 scored 11.5/15 on Cat C, 3.7s avg
const CRISIS_FL_BUDGET          = 512; // 2.5 Flash-Lite at budget 512 scored 12/15 on Cat C, best in family
const DEEP_RESPONSE_BUDGET      = 128; // cron / weekly synthesis — quality matters more than latency

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

      // Prefer the server-supplied Retry-After / retry_after when present.
      // Gemini sometimes returns it as a Retry-After header (seconds) and
      // sometimes inside the JSON error body's details. The SDK surfaces the
      // raw error text in err.message, so we sniff a few shapes. Falls back
      // to exponential backoff (1s, 2s, 4s) when nothing useful is present.
      const serverWaitMs = parseRetryAfter(err);
      const expoMs = Math.pow(2, i) * 1000;
      const wait = Math.min(
        Math.max(serverWaitMs ?? expoMs, expoMs),
        30_000, // cap so a runaway value can't pin the Worker
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

// Best-effort extraction of a retry-after hint from a Gemini SDK error.
// Looks at: err.headers['retry-after'] (string seconds), err.retryAfter
// (number seconds), and a JSON body in err.message with retryInfo.retryDelay.
// Returns milliseconds, or null when nothing trustworthy is present.
function parseRetryAfter(err) {
  if (!err) return null;
  // 1. Explicit numeric field (SDK convenience)
  if (typeof err.retryAfter === 'number' && err.retryAfter > 0) {
    return Math.min(err.retryAfter * 1000, 30_000);
  }
  // 2. Header style (string seconds)
  const header = err.headers?.['retry-after'] || err.headers?.['Retry-After'];
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 30_000);
  }
  // 3. Embedded protobuf-style detail in error message: "retryDelay":"42s"
  const m = (err.message || '').match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (m) {
    const ms = Math.round(parseFloat(m[1]) * 1000);
    if (ms > 0) return Math.min(ms, 30_000);
  }
  return null;
}

/**
 * Generate content with automatic Primary → Fallback chain.
 * Use this for cron jobs and background tasks instead of direct ai.models.generateContent.
 *
 * Architecture B+ chain:
 *   1. 2.5 Flash-Lite GA · dynamic budget   (PRIMARY_TEXT_MODEL)
 *   2. 2.5 Flash GA · budget 8192 fallback   (FALLBACK_TEXT_MODEL)
 */
export async function generateWithFallback(env, contents, config = {}) {
  const ai = getAI(env);

  // Ensure thinking config is present. Caller may override via config.thinkingConfig.
  const primaryConfig = withThinkingDefaults(config, { thinkingBudget: DEFAULT_THINKING_BUDGET });
  const fallbackConfig = withThinkingDefaults(config, { thinkingBudget: 8192 });

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

// Helper: merge a thinkingConfig into a request config if one isn't already set.
// Defaults to thinkingBudget unless thinkingLevel is explicitly passed.
function withThinkingDefaults(baseConfig, defaults) {
  const out = { ...baseConfig };
  if (out.thinkingConfig) return out; // caller already specified
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
  // Hash includes clinical directive so cache invalidates when the clinical
  // protocol is edited, not just the persona.
  const cacheKey = `gemini_cache_${model}_${hashStr(personaInstruction + (mentalHealthDirective || '')).slice(0, 16)}`;

  // Check in-memory cache first, but validate it's still alive on Google
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

  // Persona + formatting rules + clinical protocol all cached together.
  // This ensures MENTAL_HEALTH_DIRECTIVE reaches the model on cache-hit calls,
  // not just on cache-miss calls. The register override inside the directive
  // means it's inert during casual chat but always available when warm register
  // activates.
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
    console.error(`⚠️ Cache creation failed for ${PRIMARY_TEXT_MODEL}: ${err.message}`);
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
  // codeExecution removed: was leaking ⚙️ Computing... segments into user-facing
  // replies (notably after reminder/tool flows). The Python sandbox cannot access
  // env, DB, KV, or user data — it was only ever useful for arithmetic, which our
  // tools already handle. opts.skipCodeExecution is now a no-op kept for call-site
  // compatibility; remove in a follow-up cleanup.
  const tools = [{ functionDeclarations: normalizedTools }, { googleSearch: {} }];

  const config = {
    systemInstruction,
    tools,
    toolConfig: { includeServerSideToolInvocations: true },
    temperature: 1.0,
  };

  // Thinking config: 2.5 GA models use thinkingBudget (number, -1=dynamic, 0=off,
  // up to 24576). 3.x preview models use thinkingLevel ('minimal'|'low'|'medium'|
  // 'high'). Both cannot be set in the same call. Default to dynamic budget for
  // the 2.5 GA primary; callers can pass opts.thinkingBudget or opts.thinkingLevel
  // to override. Combined-evaluation bundle showed dynamic at 73.0/108 and budget
  // 512 at 73.5/108 — essentially tied — and dynamic was 2.3s faster on average.
  config.thinkingConfig = resolveThinkingConfig(opts, { thinkingBudget: DEFAULT_THINKING_BUDGET });

  return config;
}

function buildCachedConfig(cacheName, opts = {}) {
  const config = {
    cachedContent: cacheName,
    temperature: 1.0,
  };

  config.thinkingConfig = resolveThinkingConfig(opts, { thinkingBudget: DEFAULT_THINKING_BUDGET });

  return config;
}

// Resolve which thinking config to use for a call. Precedence: explicit
// opts.thinkingBudget > opts.thinkingLevel > the supplied default. Returns
// an object suitable for spreading into the request config.
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

// ---- Non-streaming: waits for full response (needed for function calling) ----
// opts.fastFail: skip the retry loop — used when we're already recovering
// from a 503 on a different transport and don't want to compound the wait.
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

// ---- True streaming: yields text chunks as Gemini generates them ----
// Used for the animated text appearing effect via Telegram's sendMessageDraft.
//
// READ-IDLE WATCHDOG: If no chunk arrives for STREAM_IDLE_MS while the
// connection is still open, throw StreamIdleError. This surfaces silent
// stalls as a distinct signal instead of letting Cloudflare kill the
// invocation with no trace. The handler can then fall back cleanly.
// This is NOT a total-generation timeout — there is no cap on overall
// response length, only on inter-chunk silence.
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
    // Initial call failed (network, 4xx, 5xx). Surface error details
    // before falling back so logs capture what Gemini actually returned.
    // fastFail: skip the 3x retry loop inside sendChatMessage — we already
    // have one failure from the streaming attempt; burning 7s of backoff
    // against the same overloaded model just causes Telegram to cancel
    // the webhook.
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

    // Observability: surface finishReason + blockReason so the handler can log them
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


// ---- Short-response generation (greetings, observations, listen-mode) ----
// Path B step 1: route through Cloudflare Gemma 4 first, fall back to Gemini
// Flash-Lite, then Flash. Gemma handles ~80% of these cleanly and is free —
// Gemini preview overload (the cause of silent morning check-ins) no longer
// breaks the bot.
//
// Each tier gets one attempt. No exponential backoff between tiers — that
// only delays the user when Gemini is overloaded.
//
// systemPrompt is appended to the system instruction so the model knows it's
// generating a short Telegram-shaped message.
const SHORT_RESPONSE_GUIDE = '\n\nYou are generating a brief message for a Telegram bot. Keep it to 2-4 complete sentences. Be fully in character. No asterisks, no markdown, no HTML tags. You MUST finish every sentence completely. Never stop mid-sentence or mid-thought.';

export async function generateShortResponse(prompt, systemInstruction, env) {
  const fullSystem = `${systemInstruction}${SHORT_RESPONSE_GUIDE}`;

  // Tier 1: Gemma 4 via Cloudflare (free, fast, independent of Gemini)
  if (env.AI) {
    try {
      const { runCfAi } = await import('../ai-gateway');
      const result = await runCfAi(env.AI, '@cf/google/gemma-4-26b-a4b-it', {
        messages: [
          { role: 'system', content: fullSystem },
          { role: 'user', content: prompt },
        ],
        temperature: 1.0,
        max_tokens: 1000,
      });
      const text = _extractCfText(result);
      if (text) return _trimTrailing(text);
      console.warn('Gemma returned empty text, falling through to Gemini');
    } catch (err) {
      console.warn('Gemma short-response failed, falling through to Gemini:', err.message);
    }
  }

  // Tier 2: Gemini Flash-Lite (preview, cheap)
  try {
    const response = await getAI(env).models.generateContent({
      model: FLASH_LITE_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: fullSystem, temperature: 1.0, maxOutputTokens: 1000 }
    });
    const text = _extractGeminiText(response);
    if (text) return _trimTrailing(text);
  } catch (err) {
    console.warn('Flash-Lite short-response failed, falling through to Flash:', err.status || '', err.message);
  }

  // Tier 3: Gemini Flash (more reliable, more expensive)
  const response = await getAI(env).models.generateContent({
    model: FALLBACK_TEXT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { systemInstruction: fullSystem, temperature: 1.0, maxOutputTokens: 1000 }
  });
  return _trimTrailing(_extractGeminiText(response));
}

function _extractCfText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (result.choices?.[0]?.message?.content) return result.choices[0].message.content;
  return result.response || '';
}

function _extractGeminiText(response) {
  return response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';
}

function _trimTrailing(text) {
  text = (text || '').trim();
  // If text doesn't end with sentence punctuation, trim to the last complete sentence.
  if (text && !/[.!?…"']$/.test(text)) {
    const ends = ['. ', '! ', '? ', '.', '!', '?'].map(s => text.lastIndexOf(s)).filter(i => i > 0);
    if (ends.length) text = text.slice(0, Math.max(...ends) + 1).trim();
  }
  return text;
}


// ---- Deep Response Generation (Pro model, low budget) ----
// Used for therapeutic synthesis, weekly reports, and other cron-tolerant work
// where quality matters more than latency. No "brief message" override — the
// caller controls length via prompt.
//
// Primary: 2.5 Pro budget 128 (68/108 in bundle, 11.5/15 on Cat C — best Pro tier)
// Fallback: 2.5 Flash-Lite budget 512 (73.5/108, 12/15 on Cat C — best in family)
//
// Counter-intuitive but data-confirmed: 2.5 Pro budget 128 outperforms budget
// 8192 and 24576 on this workload. Higher budget often causes Pro to overthink
// simple tool decisions. Callers can still pass opts.thinkingBudget to override.
export async function generateDeepResponse(prompt, systemInstruction, env, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens || 2000;
  // Translate legacy thinkingLevel ('low'|'medium'|'high') to a 2.5 Pro budget,
  // so older callers still work without code changes.
  const legacyLevelToBudget = { minimal: 0, low: 128, medium: 8192, high: 24576 };
  let budget = DEEP_RESPONSE_BUDGET;
  if (typeof opts.thinkingBudget === 'number') budget = opts.thinkingBudget;
  else if (opts.thinkingLevel && legacyLevelToBudget[opts.thinkingLevel] !== undefined) {
    budget = legacyLevelToBudget[opts.thinkingLevel];
  }

  const primaryConfig = {
    systemInstruction,
    temperature: 1.0,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: budget },
  };
  const fallbackConfig = {
    systemInstruction,
    temperature: 1.0,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: CRISIS_FL_BUDGET },
  };

  const response = await withRetry(
    () => getAI(env).models.generateContent({
      model: DEEP_RESPONSE_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: primaryConfig,
    }),
    2,
    // Fallback: 2.5 Flash-Lite budget 512 — best non-Pro on mental health work.
    () => getAI(env).models.generateContent({
      model: PRIMARY_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: fallbackConfig,
    })
  );

  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';
  return text.trim();
}

// ---- Background-task Gemini helper ----
// Used by cfAi.js, personaEvolution.js, etc. for non-user-facing background work
// (tagging, observation extraction, summarisation). Returns trimmed text or
// null on failure — mirrors the cfAiGenerate shape so call sites can swap
// providers without restructuring.
//
// Defaults: thinkingBudget -1 (dynamic) on 2.5 GA models. Pass opts.thinkingBudget
// to override (0=off, 128=low, 512=balanced, 8192=high). Pass opts.thinkingLevel
// for 3.x preview models (minimal | low | medium | high).
export async function geminiBackgroundGenerate(env, model, prompt, systemPrompt = '', opts = {}) {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const ai = getAI(env);
    const thinking = resolveThinkingConfig(opts, { thinkingBudget: DEFAULT_THINKING_BUDGET });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: systemPrompt || undefined,
        temperature: 1.0,
        maxOutputTokens: opts.maxOutputTokens ?? 2000,
        thinkingConfig: thinking,
      },
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
    return trimmed || null;
  } catch (err) {
    console.error(`Gemini bg error (${model}):`, err.message?.slice(0, 200));
    return null;
  }
}


// ---- Crisis-lane Two-Model Parallel Race ----
// Used when the conversation classifier flags the turn as 'crisis' (or any
// other lane where mental-health quality dominates). Fires 2.5 Pro budget 128
// AND 2.5 Flash-Lite budget 512 in parallel and returns whichever succeeds
// first. Token cost roughly doubles on crisis turns; absolute volume is small
// (estimated <50/day) so the safety net is worth the spend.
//
// Combined-evaluation bundle scores on Cat C (mental health):
//   2.5 Pro · budget 128       — 11.5/15, 3.7s avg
//   2.5 Flash-Lite · budget 512 — 12.0/15, 8.6s avg (best in Gemini family)
//
// If both fail (both reject or both error), falls through to a single 2.5 Pro
// dynamic call as last resort. Returns trimmed text.
export async function generateCrisisResponse(prompt, systemInstruction, env, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens || 2000;
  const baseConfig = {
    systemInstruction,
    temperature: 1.0,
    maxOutputTokens,
  };

  const proCall = () => getAI(env).models.generateContent({
    model: DEEP_RESPONSE_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { ...baseConfig, thinkingConfig: { thinkingBudget: CRISIS_PRO_BUDGET } },
  });
  const flCall = () => getAI(env).models.generateContent({
    model: PRIMARY_TEXT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { ...baseConfig, thinkingConfig: { thinkingBudget: CRISIS_FL_BUDGET } },
  });

  // Wrap each call so a failure resolves to a sentinel instead of rejecting.
  // Then race for the first non-sentinel result.
  const tagged = async (label, fn) => {
    try {
      const response = await fn();
      const text = response.candidates?.[0]?.content?.parts
        ?.filter(p => p.text && !p.thought)
        ?.map(p => p.text)
        ?.join('') || '';
      if (!text.trim()) return { label, ok: false, error: 'empty_response' };
      return { label, ok: true, text: text.trim() };
    } catch (err) {
      return { label, ok: false, error: err?.message || String(err) };
    }
  };

  const proPromise = tagged('pro_b128', proCall);
  const flPromise = tagged('fl_b512', flCall);

  // First-past-the-post: whoever returns a successful payload wins.
  // If the first to finish failed, await the other before declaring failure.
  const first = await Promise.race([proPromise, flPromise]);
  if (first.ok) {
    console.log(`🚨 Crisis lane winner: ${first.label}`);
    return first.text;
  }

  console.warn(`🚨 Crisis lane ${first.label} failed (${first.error?.slice(0, 100)}), awaiting other arm`);
  const second = first.label === 'pro_b128' ? await flPromise : await proPromise;
  if (second.ok) {
    console.log(`🚨 Crisis lane second arm winner: ${second.label}`);
    return second.text;
  }

  // Both raced arms failed. Last-resort fallback: 2.5 Pro dynamic, single call.
  console.warn(`🚨 Crisis lane both arms failed (${second.label}: ${second.error?.slice(0, 100)}), falling through to Pro dynamic`);
  const fallback = await getAI(env).models.generateContent({
    model: DEEP_RESPONSE_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { ...baseConfig, thinkingConfig: { thinkingBudget: -1 } },
  });
  const text = fallback.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';
  return text.trim();
}
