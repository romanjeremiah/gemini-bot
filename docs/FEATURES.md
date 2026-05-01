# Xaridotis — Feature Inventory

*Last updated: April 2026*

This document is a living inventory of what Xaridotis can do. It is grounded in the actual code (commands, tools, scheduled jobs, schema, KV keys), not aspirational design. When you add or remove a feature, update this file.

---

## 1. Conversation core

### Path B router — provider abstraction (April 2026)

Two AI providers behind a unified `AIProvider` interface (`src/types/ai.js`):

- **CloudflareProvider** (`src/ai/cloudflare.js`) — Gemma 4 + Qwen3 30B, OpenAI-compatible function calling, streaming via event-source, routed through AI Gateway for caching/observability
- **GeminiProvider** (`src/ai/gemini-provider.js`) — adapter wrapping the existing Gemini SDK code, preserves cache + tool loop + multimodal

The router (`src/ai/router.js`) decides which provider handles each turn based on a fixed set of rules. Default is Cloudflare Gemma; Gemini is reserved for emotional, multimodal, and active-checkin paths.

Per-user persona evolution lives in `src/services/persona.js` and `src/services/personaEvolution.js`. The system instruction is rebuilt per turn with a layered overlay (BASE + user context + evolved traits + clinical directive + formatting rules + dynamic context). The evolution job runs daily at 04:00 alongside style card consolidation; uses cheap `@cf/meta/llama-3.1-8b-instruct` to extract durable observations from recent chat summaries.

Tool-loop bound: `MAX_TOOL_ROUNDS = 5` (matching Eukara). Selective routing logs (only non-default routes) keep tail clean.

### Multi-tier model routing

TierModelWhenPro`gemini-3.1-pro-preview`Complex tasks, mental health keywords, long messages, code/architectureFlash`gemini-3-flash-preview`Substantive medium-length chatFlash-Lite`gemini-3.1-flash-lite-preview`Short casual, acknowledgments, check-in replies

- `/model` command overrides the tier for the next message
- Fallback chain: Pro → Flash on 503/overload, Flash → non-streaming on idle stall
- Same chain for everyone (no owner/guest asymmetry)

### Streaming and animation

- Animated text rendering via `sendMessageDraft` (Telegram Bot API 9.3+)
- Throttled chunk delivery for smooth typing feel
- Read-idle watchdog (25s) to surface silent stalls as logged errors
- Non-streaming on media inputs (voice, image, video, audio)

### Persona

- Single unified persona Xaridotis with backwards-compat aliases (`tenon`, `nightfall`, `tribore`)
- Per-user `persona_config` D1 table for traits and custom instructions
- Style card auto-consolidation (cron-driven, 04:00 daily)
- Register-aware tone: warm/therapeutic vs default casual, gated by emotional keywords
- `MENTAL_HEALTH_DIRECTIVE` baked into context cache
- `/persona` command for switching

---

## 2. Memory and context

### Storage layers

- D1 tables: `memories`, `episodes`, `chat_summaries`, `knowledge_graph`, `mood_journal`, `training_pairs`, `user_profiles`, `persona_config`, `reminders`
- Vectorize index `conversation-context` (768-dim cosine) for semantic recall
- KV `CHAT_KV` for ephemeral state (locks, drafts, schedule keys)
- R2 bucket `gemini-bot-media` for user-uploaded media

### Retrieval per turn

SourceVariableBacked byRecent memories`memCtx`D1 `memories`Semantic search`semanticCtx`VectorizeEpisode memory`episodeCtx`D1 `episodes`Procedural memory`proceduralCtx`D1 patternsKnowledge graph`graphCtx`D1 `knowledge_graph` triplesPlan context`planCtx`KV active flowsStyle cardprepended to system instructionD1 `user_profiles`

### Context caching

- Gemini explicit cache via `getOrCreateCache` — persona + formatting + directive cached at \~13KB
- Per-model caches (Pro / Flash / Flash-Lite separately)

---

## 3. Tools available to Gemini (24)

`checklist`, `cloudflare`, `draft`, `effect` (Telegram premium effects), `episode` (save_episode), `fetch`, `github`, `image` (Nano Banana), `location`, `memory` (save_memory), `mood` (log_mood_entry), `pin` (pin/unpin messages), `poll`, `quietHours` (set/clear quiet hours), `quote`, `reaction`, `reminder`, `research` (deep research with Google Search grounding), `schedule`, `therapeutic` (saveTherapeuticNote, getTherapeuticNotes), `timezone` (update_timezone), `voice` (TTS reply).

Source of truth: `src/tools/index.js`.

---

## 4. Health check-in system

### Scheduled cron jobs (every minute)

- Morning check-in (08:30 user-local): mood poll + opening message
- Midday check-in (13:00 user-local)
- Evening check-in (20:30 user-local)
- Medication nudges
- Style card consolidation (04:00)
- Weekly mental health report (Sunday 20:00)
- Memory consolidation
- Spontaneous outreach (random, low probability, gated by quiet hours)
- Curiosity digest
- Autonomous research
- Self-improvement reflection
- Daily study share
- Architecture evolution
- Accountability nudges

### Mood tracking

- 0–10 bipolar scale via `MOOD_POLL_OPTIONS` (canonical, used by `/mood` and scheduled polls — single source of truth in `src/config/moodScale.js`)
- `mood_journal` D1 table with 19 columns: mood, sleep, medication, activities, notes, photo, AI observation, clinical tags
- Pro-model analysis on poll answer with episode/semantic context retrieval
- Queue-routed (15-min wall clock, 3 retries) for resilience

### Quiet hours

- Tool-driven via `set_quiet_hours` (Gemini decides when to silence)
- Capped at 48 hours
- Medication check-ins still fire (deliberate)

---

## 5. Background intelligence

### Listen mode

- `/listen` — bot silently buffers messages, reacts with contextual emoji
- `/done` — emits a summary of what was buffered
- Buffer stored in KV with 24h TTL

### Reaction feedback (RLHF)

- User reactions on bot messages saved as positive/negative training signal
- `training_pairs` D1 table for future fine-tuning

### Silent observation

- Background extraction of facts, emotions, patterns from conversations
- Uses Cloudflare Workers AI (free tier) for cheap observation

### Spontaneous outreach

- Random gated proactive messages
- 10–19 user-local-time window
- Respects quiet hours and user-active state

---

## 6. User commands

| Command | Purpose |
|---|---|
| `/start` | Onboarding |
| `/persona` | List personas |
| `/clear` | Clear chat history |
| `/memories` | View stored memories |
| `/forget` | Delete specific memory |
| `/model` | Override model tier (Pro/Flash) for next message |
| `/listen` `/done` | Listen mode |
| `/mood` | Manual mood check-in |
| `/timezone` | Set/view timezone (uses canonical per-chat KV) |
| `/setlocation` | Share location for automatic timezone detection |
| `/testpoll` | Debug command — test poll_answer webhook |
| `/firecron` | Owner-only diagnostic — manually queue a scheduled task. Args: `morning`, `midday`, `evening`, `mood_poll`, `med_nudge`, `spontaneous_outreach`, `queue_test` |
| `/research` | Start a deep research task |
| `/researchhistory` | List past research |
| `/researchfull` | Full text of one research result |
| `/architect` | Meta command for self-modification |
| `/schedule` | View/set cron schedule |

---

## 7. Message types handled

- Text messages (private + business connections)
- Voice notes (transcription via Gemini multimodal)
- Audio files
- Photos (vision via Gemini)
- Video, video notes
- Documents
- Stickers
- Locations (passive timezone update via Google Time Zone API)
- Edited locations / live locations (debounced 30-min)
- Polls and poll answers
- Callback queries (inline buttons)
- Message reactions
- Business connections

---

## 8. Outputs Xaridotis can produce

- Plain text replies (HTML formatted, sanitised for Telegram)
- Voice notes (Gemini TTS, `gemini-2.5-pro-preview-tts`)
- Generated images (Nano Banana Pro / Flash)
- Drafts (animated typing effect)
- Polls
- Pins
- Reactions/emoji
- Location pins
- Inline keyboards (callback buttons)
- Reply keyboards (e.g. share-location button)
- Telegram premium effects (`effectTool`)
- Long messages (auto-split with `sendLongMessage`)
- Typing indicators (`sendChatAction`)

---

## 9. Infrastructure / observability

### Routing

- Hybrid dispatch: text awaits inline, media + callbacks via `ctx.waitUntil`, complex/Pro tasks via Cloudflare Queue (`TASK_QUEUE`)
- Queue handles: `health_checkin`, `med_nudge`, `mood_poll`, `mood_poll_answer`, `user_message`, `spontaneous_outreach`, `queue_test`
- Default 3-retry queue policy with graceful fallback messaging on persistent failure

### Logging

- Structured JSON logs for `wrangler tail`
- Per-pass diagnostics: `prompt_sizes`, `cache_setup_done`, `chat_ready`, `generation_start/complete/failed`
- Tool-call name logging for debugging tool loops
- Cron diagnostics: `cron_run`, `cron_window_skip`, `cron_morning_enqueue`
- Temporary `dynamic_context_dump` for persona drift investigation (Pass 2 + 3 input)

### Timezone

- Per-chat IANA timezone resolution via Google Time Zone API
- Triggered by location pin (passive) or `/setlocation` (explicit)
- Debounced live-location updates (30-min window)
- Default `Etc/UTC` fallback when nothing pinned
- Canonical KV key: `timezone_<chatId>` (single per-chat key replaces older dual-key scheme)

---

## 10. Backlog

### Pass 2 — mood check-in flow rebuild

- Photo collection in mood check-in
- Activities collection with inline-button samples
- Notes/comments collection
- Per-question Gemini-chosen emoji
- Mood trend summary in evening response
- `entry_type` bug (always tagged "evening" on `/mood`)
- `todayLondon` migration to user-local

### Pass 3 — memory architecture

- GraphRAG audit and modernisation
- Memory decay (specific old anchors still being referenced)
- Memory retention policy

### Deferred from Plan B

- Priority inference mode for tier 1+2
- Full tier cascade (currently hand-rolled Pro→Flash, target: 4-tier with Flash-Lite as 4b)
- Cloudflare Workers AI fallback (tier 5+6) — explicitly deferred

---

## How to keep this file accurate

When you ship something, update the relevant section. When something is removed, delete it from this file. Source of truth always wins over this document — if the code disagrees with this file, fix this file.

Useful greps for verification:

```bash
# Commands
grep -n 'case "/' src/bot/handlers.js

# Tool registry
ls src/tools/

# Cron handlers
grep -n '^async function handle' src/index.js

# Queue task types
grep -n 'TASK_QUEUE.send' src/index.js

# D1 tables
grep "CREATE TABLE" schema.sql
```
