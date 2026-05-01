import { GoogleGenAI } from '@google/genai';
import { toolDefinitions } from '../../tools/index.js';

export const PRIMARY_TEXT_MODEL   = 'gemini-3.1-pro-preview';
export const FALLBACK_TEXT_MODEL  = 'gemini-3-flash-preview';
export const FLASH_LITE_TEXT_MODEL = 'gemini-3.1-flash-lite-preview';
const PRIMARY_IMAGE_MODEL  = 'gemini-3-pro-image-preview';     // Nano Banana Pro — best quality gen + edit
const FALLBACK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'; // Nano Banana 2 — fast fallback

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
      const wait = Math.pow(2, i) * 1000;
      console.log(`⏳ Gemini retry ${i + 1}/${maxRetries} in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (fallbackFn) {
    console.log(`🔄 Primary exhausted — switching to fallback model`);
    return await fallbackFn();
  }
  throw lastError;
}

/**
 * Generate content with automatic Pro → Flash fallback.
 * Use this for cron jobs and background tasks instead of direct ai.models.generateContent.
 */
export async function generateWithFallback(env, contents, config = {}) {
  const ai = getAI(env);
  const proConfig = { ...config };
  const flashConfig = { ...config };

  const doGenerate = (model) => ai.models.generateContent({
    model, contents, config: proConfig
  });

  const response = await withRetry(
    () => doGenerate(PRIMARY_TEXT_MODEL),
    2,
    () => doGenerate(FALLBACK_TEXT_MODEL)
  );

  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';

  return { text: text.trim(), response };
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
        tools: [{ functionDeclarations: normalizedTools }, { googleSearch: {} }, { codeExecution: {} }],
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
  const tools = [{ functionDeclarations: normalizedTools }, { googleSearch: {} }];
  if (!opts.skipCodeExecution) tools.push({ codeExecution: {} });

  const config = {
    systemInstruction,
    tools,
    toolConfig: { includeServerSideToolInvocations: true },
    temperature: 1.0,
  };

  // Gemini 3.1 Pro supports 'low', 'medium', 'high' thinking levels.
  // Thinking cannot be disabled on Pro. Default to 'low' for speed;
  // callers can pass opts.thinkingLevel to override for therapeutic/complex tasks.
  if (opts.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
  }

  return config;
}

function buildCachedConfig(cacheName, opts = {}) {
  const config = {
    cachedContent: cacheName,
    temperature: 1.0,
  };

  if (opts.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
  }

  return config;
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
    if (part.executableCode) yield { type: 'text', text: `\n<i>⚙️ Computing...</i>\n` };
    if (part.codeExecutionResult) yield { type: 'text', text: `\n<b>Result:</b> <code>${part.codeExecutionResult.output.trim()}</code>\n` };
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
      if (part.executableCode) yield { type: 'text', text: `\n<i>⚙️ Computing...</i>\n` };
      if (part.codeExecutionResult) yield { type: 'text', text: `\n<b>Result:</b> <code>${part.codeExecutionResult.output.trim()}</code>\n` };
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


// ---- Deep Response Generation (Pro model, high thinking) ----
// Used for therapeutic synthesis where quality matters more than speed.
// No "brief message" override — the caller controls the length via prompt.
// Pro model with configurable thinkingLevel ('low' | 'medium' | 'high').
export async function generateDeepResponse(prompt, systemInstruction, env, opts = {}) {
  const thinkingLevel = opts.thinkingLevel || 'medium';
  const maxOutputTokens = opts.maxOutputTokens || 2000;

  const config = {
    systemInstruction,
    temperature: 1.0,
    maxOutputTokens,
    thinkingConfig: { thinkingLevel },
  };

  const response = await withRetry(
    () => getAI(env).models.generateContent({
      model: PRIMARY_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config,
    }),
    2,
    // Fallback: retry with Flash if Pro is unavailable
    () => getAI(env).models.generateContent({
      model: FALLBACK_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction, temperature: 1.0, maxOutputTokens },
    })
  );

  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';
  return text.trim();
}
