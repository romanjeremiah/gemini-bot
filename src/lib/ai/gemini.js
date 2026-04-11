import { GoogleGenAI } from '@google/genai';
import { toolDefinitions } from '../../tools/index.js';

export const PRIMARY_TEXT_MODEL   = 'gemini-3.1-pro-preview';
export const FALLBACK_TEXT_MODEL  = 'gemini-3-flash-preview';
const PRIMARY_IMAGE_MODEL  = 'gemini-3-pro-image-preview';     // Nano Banana Pro — best quality gen + edit
const FALLBACK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'; // Nano Banana 2 — fast fallback

const CACHE_TTL = '3600s';
const MIN_CACHE_TOKENS_GEMINI3 = 4096;
const CHARS_PER_TOKEN = 4;

let _ai = null;
let _aiDirect = null; // Direct connection (no gateway) for image gen

function getAI(env) {
  if (!_ai) {
    const opts = { apiKey: env.GEMINI_API_KEY };
    // Proxy through Cloudflare AI Gateway if configured (caching, analytics, rate limiting)
    if (env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID) {
      opts.httpOptions = {
        baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/google-ai-studio`,
      };
      console.log('🌐 AI Gateway enabled');
    }
    _ai = new GoogleGenAI(opts);
  }
  return _ai;
}

// Direct connection for image gen — bypasses gateway to avoid extra latency
function getAIDirect(env) {
  if (!_aiDirect) {
    _aiDirect = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return _aiDirect;
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
  const ai = getAIDirect(env);
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

async function getOrCreateCache(personaInstruction, formattingRules, env, model = PRIMARY_TEXT_MODEL) {
  const cacheKey = `gemini_cache_${model}_${hashStr(personaInstruction).slice(0, 16)}`;

  if (_cacheNames.has(cacheKey)) return _cacheNames.get(cacheKey);

  const kvCacheName = await env.CHAT_KV.get(cacheKey);
  if (kvCacheName) {
    try {
      // Use direct connection for cache management (Gateway doesn't proxy cache calls)
      await getAIDirect(env).caches.get({ name: kvCacheName });
      _cacheNames.set(cacheKey, kvCacheName);
      return kvCacheName;
    } catch {
      console.log('🗑️ Cached content expired on Google side, recreating...');
    }
  }

  const staticContent = `${personaInstruction}\n${formattingRules}`;
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
    // Use direct connection for cache creation (Gateway doesn't proxy cache management)
    const cache = await getAIDirect(env).caches.create({
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
  // Code execution is incompatible with audio/video inline data
  if (!opts.skipCodeExecution) tools.push({ codeExecution: {} });
  return {
    systemInstruction,
    tools,
    toolConfig: { includeServerSideToolInvocations: true },
    temperature: 1.0,
    maxOutputTokens: 8192,
  };
}

function buildCachedConfig(cacheName) {
  return {
    cachedContent: cacheName,
    temperature: 1.0,
    maxOutputTokens: 8192,
  };
}

export async function createChat(history, systemInstruction, env, cacheContext = null, model = null, opts = {}) {
  const useModel = model || PRIMARY_TEXT_MODEL;
  const config = cacheContext?.cacheName
    ? buildCachedConfig(cacheContext.cacheName)
    : buildConfig(systemInstruction, opts);

  console.log(`🤖 Model: ${useModel}`);
  return getAI(env).chats.create({
    model: useModel,
    config,
    history: history || [],
  });
}

export async function setupCache(personaInstruction, formattingRules, dynamicContext, env, model = PRIMARY_TEXT_MODEL) {
  const cacheName = await getOrCreateCache(personaInstruction, formattingRules, env, model);
  if (!cacheName) return null;
  return { cacheName, dynamicPrefix: dynamicContext };
}

// ---- Non-streaming: waits for full response (needed for function calling) ----
export async function* sendChatMessage(chat, message) {
  const response = await withRetry(
    () => chat.sendMessage({ message }),
    3, null
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
// Falls back to non-streaming if sendMessageStream is unavailable.
export async function* sendChatMessageStream(chat, message) {
  try {
    const stream = await chat.sendMessageStream({ message });
    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text && !part.thought) {
          yield { type: 'text', text: part.text };
        }
        if (part.executableCode) {
          yield { type: 'text', text: `\n<i>⚙️ Computing...</i>\n` };
        }
        if (part.codeExecutionResult) {
          yield { type: 'text', text: `\n<b>Result:</b> <code>${part.codeExecutionResult.output.trim()}</code>\n` };
        }
      }
      // Function calls in streaming come in the final chunk
      const calls = parts.filter(p => p.functionCall && p.functionCall.name !== 'googleSearch');
      if (calls.length) yield { type: 'functionCall', calls };

      const gm = chunk.candidates?.[0]?.groundingMetadata;
      if (gm) yield { type: 'groundingMetadata', metadata: gm };
    }
  } catch (err) {
    // If streaming fails, fall back to non-streaming
    console.warn('⚠️ Stream fallback to non-streaming:', err.message);
    yield* sendChatMessage(chat, message);
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
  const doGenerate = (m) => getAIDirect(env).models.generateContent({
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


// ---- UI Text Generation (Fast & Contextual) ----
// Uses Flash model via direct connection for speed. No tools, no history.
export async function generateShortResponse(prompt, systemInstruction, env) {
  const response = await withRetry(
    () => getAIDirect(env).models.generateContent({
      model: FALLBACK_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: `${systemInstruction}\n\nYou are generating a brief message for a Telegram bot. Keep it to 2-4 complete sentences. Be fully in character. No asterisks, no markdown, no HTML tags. You MUST finish every sentence completely. Never stop mid-sentence or mid-thought.`,
        temperature: 1.0,
        maxOutputTokens: 1000,
      }
    }),
    2, null
  );
  let text = response.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought)?.map(p => p.text)?.join('') || '';
  text = text.trim();
  // Safety: if text was truncated mid-sentence, trim to last complete sentence
  if (text && !/[.!?…"']$/.test(text)) {
    const lastComplete = text.lastIndexOf('. ');
    const lastExclaim = text.lastIndexOf('! ');
    const lastQuestion = text.lastIndexOf('? ');
    const lastEnd = Math.max(
      lastComplete,
      lastExclaim,
      lastQuestion,
      text.lastIndexOf('.'),
      text.lastIndexOf('!'),
      text.lastIndexOf('?')
    );
    if (lastEnd > 0) text = text.slice(0, lastEnd + 1).trim();
  }
  return text;
}
