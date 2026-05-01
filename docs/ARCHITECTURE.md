# Xaridotis Architecture

*Last updated: April 2026*

This document describes how Xaridotis is wired together: entry points, request flow, models, storage, and the order things happen on a typical user message. Like `FEATURES.md`, this is grounded in the actual code, not aspirational. If the code disagrees with this document, fix this document.

---

## High-level shape

A single Cloudflare Worker fronts everything. It receives webhooks from Telegram, decides how to handle them, calls AI providers, and stores state. There is no separate backend, no FastAPI, no microservices.

```
                Telegram cloud
                      │ webhook POST
                      ▼
         ┌────────────────────────────┐
         │  Cloudflare Worker (Edge)  │
         │  src/index.js              │
         │  ─ fetch handler           │ ◄── messages, commands, polls
         │  ─ scheduled handler       │ ◄── cron tick every 60s
         │  ─ queue handler           │ ◄── async tasks
         └─────┬─────────┬────────────┘
               │         │
       ┌───────┴───┐ ┌───┴────────┐
       │ Storage   │ │ AI providers│
       │ • D1      │ │ • Gemini    │
       │ • KV      │ │ • Workers AI│
       │ • R2      │ │ • Google TZ │
       │ • Vectorize│ │ Maps API    │
       │ • Queue   │ │             │
       └───────────┘ └─────────────┘
```

---

## Request flow

There are three entry points, each handled differently.

### Entry 1: Telegram webhook (user activity)

```
POST /  (Telegram update)
  │
  ▼
update.message?         → message router
update.callback_query?  → callback handler
update.poll_answer?     → mood poll path
update.business_message? → business chat path
update.message_reaction? → RLHF feedback
update.edited_message.location? → live timezone update
  │
  ▼
Hybrid dispatch decision:
  • text message      → await inline (≤60s Telegram patience)
  • media (voice/image) → ctx.waitUntil (≤30s ceiling)
  • complex/Pro task   → TASK_QUEUE.send (15-min budget)
  • poll answer        → TASK_QUEUE.send (heavy Pro work)
```

### Entry 2: Scheduled (cron)

```
* * * * *  (every minute)
  │
  ▼
enqueueHealthTasks(env)
  ├ getLocalTime(chatId, env)           ← uses stored timezone
  ├ Check window: morning/midday/evening
  ├ Check guards: locked? logged? user active?
  └ TASK_QUEUE.send({ type: 'health_checkin', period, chatId })

Same tick also runs:
  • handleMedicationNudge
  • handleStyleCardConsolidation (04:00)
  • handleWeeklyReport (Sunday 20:00)
  • handleMemoryConsolidation
  • handleSpontaneousOutreach (random gated)
  • handleCuriosityDigest
  • handleAutonomousResearch
  • handleAccountabilityNudge
  • handleDailyStudy
  • handleArchitectureEvolution
  • handleSelfImprovement
```

### Entry 3: Queue consumer

```
TASK_QUEUE message arrives
  │
  ▼
switch (task.type):
  user_message           → handleMessage(task.message, env)
  mood_poll_answer       → handleMoodPollAnswer(...)
  health_checkin         → send poll, opening message
  med_nudge              → medication reminder
  spontaneous_outreach   → proactive message
  queue_test             → diagnostic
  │
  ▼
Failure handling:
  • Auto-retry up to 3 times (~30s between)
  • Final failure → user-facing fallback message
```

---

## Models — what runs where

### Conversational text — Path B router (April 2026)

The router (`src/ai/router.js`) is the single decision point for which provider+model handles each turn. ~80% of messages are routed to free Cloudflare Workers AI; Gemini is reserved for irreplaceable capabilities.

| Tier | Model | Used when |
|---|---|---|
| Default casual (CF) | `@cf/google/gemma-4-26b-a4b-it` | Casual chat, default for ~80% of messages |
| Code/analytical (CF) | `@cf/qwen/qwen3-30b-a3b-fp8` | Code keywords, analytical requests, long messages (>300 chars) |
| Pro (Gemini) | `gemini-3.1-pro-preview` | Multimodal (voice/image/video), emotional/therapeutic, active health check-in |
| Flash (Gemini) | `gemini-3-flash-preview` | Fallback when CF path fails for any reason |
| Flash-Lite (Gemini) | `gemini-3.1-flash-lite-preview` | Manual `/model lite` override |

Routing rules (in order):

1. `hasMedia` → Gemini Pro
2. `healthCheckinActive` → Gemini Pro (high thinking)
3. Emotional pattern matched → Gemini Pro
4. Code keywords or triple-backtick → CF Qwen3 30B
5. Analytical pattern matched → CF Qwen3 30B
6. Text length > 300 → CF Qwen3 30B
7. Default → CF Gemma 4

The router only logs non-default routes; casual → Gemma is silent.

If the CF path fails for any reason (model error, empty response, network issue), `handlers.js` automatically falls back to the existing Gemini Flash path with full cache + tool-loop support. This is the safety net behind Path B.

For background generation (greetings, observations, listen-mode reactions), `generateShortResponse` in `src/lib/ai/gemini.js` uses its own 3-tier cascade: Gemma → Flash-Lite → Flash. This is what unblocks scheduled morning check-ins when Gemini preview is overloaded.

### Fallback chain (when a tier fails)

Currently hand-rolled in `handlers.js`:

```
Tier 1 attempt
  │
  ├─ 503 / 429 / RESOURCE_EXHAUSTED / overloaded → Tier 2 (same prompt)
  │
  ├─ StreamIdleError (no chunks for 25s) → Tier 2 (same prompt)
  │
  └─ Flash itself stalls → retry same model non-streaming
```

Pro→Flash is automatic. Flash→Flash-Lite is **not yet wired** (deferred to Plan B Deploy B). When that's added, the chain becomes Pro → Flash → Flash-Lite.

### Image generation

RoleModelUsed whenPrimary`gemini-3-pro-image-preview` (Nano Banana Pro)Default — best qualityFallback`gemini-3.1-flash-image-preview` (Nano Banana 2)Pro overload or low-stakes generation

### Voice / TTS

`gemini-2.5-pro-preview-tts` — used by the `voice` tool to generate audio replies. Not part of the fallback chain because Telegram voice notes are a separate output channel.

### Embeddings

RoleModelDimensionsPrimary`gemini-embedding-2-preview`768 (via `outputDimensionality` param)Fallback`@cf/baai/bge-base-en-v1.5` (Workers AI)768 (native)

Both write to the same Vectorize index `conversation-context`. If Gemini embedding fails, the CF fallback fires automatically — same dimensionality so the vectors are interchangeable.

### Reranker

`@cf/baai/bge-reranker-base` (Workers AI) — cross-attention relevance scoring on retrieved memories before passing to Gemini.

### Background AI (Workers AI tier — cheap, no cost on includedNeurons)

These never fire in the user-facing reply path. Used for offline/observation work:

ModelUse`@cf/meta/llama-3.2-1b-instruct`Sentiment tagging, simple extraction (\~5 neurons)`@cf/meta/llama-3.1-8b-instruct-fp8-fast`Triple extraction (knowledge graph), silent observation (\~13 neurons)`@cf/zai-org/glm-4.7-flash`Long-text summarisation, memory consolidation (\~25 neurons)`@cf/google/gemma-4-26b-a4b-it`Function calling for low-stakes tools (Phase 2 — listed but not yet wired)

### External APIs (non-AI)

APIUseGoogle Time Zone APIResolve lat/lng → IANA timezoneGoogle web_search (via Gemini grounding)Deep research tool

---

## Order of operations on a typical user message

This is the **happy path** for a substantive text message:

```
1. Telegram webhook → fetch handler
2. Identity: extract userId, chatId, threadId
3. Throttle check, business connection check
4. Hybrid dispatch decides: await | waitUntil | queue
5. handleMessage starts:
   ├ Tier selection (Pro / Flash / Flash-Lite)
   ├ Load user_profiles, persona_config, style_card from D1
   ├ Memory retrieval:
   │    ├ Recent memories (D1)
   │    ├ Semantic search (Vectorize → reranker)
   │    ├ Episode memory (D1)
   │    ├ Procedural patterns
   │    ├ Knowledge graph triples
   │    └ Plan context (KV)
   ├ Build dynamicContext string with timezone-aware Local Time
   ├ Cache setup: getOrCreateCache for chosen tier
   ├ chat_ready
   ├ Pass 1: sendChatMessageStream (Pro/Flash) or non-streaming (media)
   │    ├ Stream chunks → throttled sendMessageDraft (animated typing)
   │    ├ If tool calls returned → loop to Pass 2 (non-streaming)
   │    └ If text → final sendMessage
   ├ Pass 2..N: tool execution → response with results → next pass
   ├ Final reply sent
   ├ Save to chat history (D1 chat_summaries)
   ├ Save embeddings (Vectorize)
   └ handler_end
6. Telegram receives 200 OK (or had it already, depending on dispatch)
```

---

## Storage layout

```
D1 (relational, durable)
├ user_profiles      ← who you are, preferences, style_card
├ persona_config     ← per-user persona traits
├ memories           ← key facts, structured remembrances
├ episodes           ← significant past conversations
├ chat_summaries     ← turn-by-turn history
├ knowledge_graph    ← entity-relation-entity triples
├ mood_journal       ← 19-column mood tracking
├ reminders          ← scheduled reminders
└ training_pairs     ← RLHF reaction signals

KV (ephemeral key-value, fast reads)
├ timezone_<chatId>          ← canonical timezone (Apr 2026)
├ last_location_<chatId>     ← coordinates of last pin
├ tz_lastcheck_<chatId>      ← live-location debounce
├ health_checkin_<period>_<date>   ← daily lock
├ health_checkin_active_<chatId>   ← active poll context
├ mood_poll_<pollId>         ← poll → context mapping
├ model_override_<chatId>    ← /model command
├ quiet_until_<chatId>       ← quiet hours
├ listen_buffer_<chatId>     ← listen mode buffer
├ last_seen_<chatId>         ← user activity tracking
└ chat_history_<chatId>      ← session memory

R2 (object storage)
└ gemini-bot-media/<userId>/<type>/<timestamp>.<ext>
   ├ audio/  (voice notes from user)
   ├ images/ (photos sent to bot)
   └ video/  (videos sent to bot)

Vectorize (semantic search)
└ conversation-context (768-dim cosine, BGE/Gemini compatible)
```

---

## What's hand-rolled vs deferred

### Hand-rolled (live today)

- Pro → Flash fallback
- Flash → non-streaming retry on idle stall
- Mood-poll queue routing
- Hybrid dispatch (await/waitUntil/queue)
- Read-idle watchdog
- Per-chat timezone via location pin

### Deferred (in backlog)

- Flash → Flash-Lite as third tier
- Priority inference mode for tier 1+2
- Cloudflare Workers AI fallback (tier 5+6)
- Single `callWithChain` helper to replace hand-rolled fallback
- `entry_type` correctness on `/mood`
- Memory decay policy

---

## Honest summary

Xaridotis is a **single Worker** that routes messages through a **3-tier Gemini cascade** (Pro / Flash / Flash-Lite) with **fallback by HTTP status**, caches static persona content per-tier, retrieves from **6 memory layers** before each Gemini call, and offloads slow work to a **Cloudflare Queue** for resilience. Cloudflare Workers AI is used for cheap offline observation but is **not** a fallback for user-facing replies yet.

---

## How to keep this file accurate

When the architecture changes, update this file. Useful greps:

```bash
# Model constants
grep -n 'TEXT_MODEL\|IMAGE_MODEL' src/lib/ai/gemini.js

# Cloudflare AI models
grep -rn '@cf/' src/

# Queue task types
grep -n 'TASK_QUEUE.send' src/index.js

# Cron handlers
grep -n '^async function handle' src/index.js
```
