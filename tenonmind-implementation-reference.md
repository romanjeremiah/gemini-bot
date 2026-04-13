# TenonMind — Implementation Reference

> **Project:** `tenon-agent` | **Runtime:** Google Cloud Run (Node 22 / Express.js) | **GCP Project:** `telegram-ai-agent-tenon`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Infrastructure & Deployment](#2-infrastructure--deployment)
3. [Bot Commands](#3-bot-commands)
4. [Personas](#4-personas)
5. [AI & Model Configuration](#5-ai--model-configuration)
6. [Tool System (14 Tools)](#6-tool-system-14-tools)
7. [Callback Actions](#7-callback-actions)
8. [Media Input Handling](#8-media-input-handling)
9. [Memory System](#9-memory-system)
10. [Therapeutic Notes System](#10-therapeutic-notes-system)
11. [Reminder System](#11-reminder-system)
12. [Text-to-Speech (TTS)](#12-text-to-speech-tts)
13. [Database Schema](#13-database-schema)
14. [KV Store](#14-kv-store)
15. [Conversation History](#15-conversation-history)
16. [Telegram API Capabilities](#16-telegram-api-capabilities)
17. [System Prompt Construction](#17-system-prompt-construction)
18. [Business Account Support](#18-business-account-support)
19. [Key Architectural Constraints & Learnings](#19-key-architectural-constraints--learnings)
20. [Pending / Planned Features](#20-pending--planned-features)

---

## 1. Architecture Overview

TenonMind is a personal Telegram AI companion bot deployed as a single Express.js service on Google Cloud Run. The overall request flow is:

```
Telegram Bot API
    │  POST / (webhook)
    ▼
src/index.js  ──  routes update type, responds 200 immediately
    │             runs processing via setImmediate (non-blocking)
    ▼
src/bot/handlers.js
    │  handleMessage()   ──  text, media, voice, stickers, documents
    │  handleCallback()  ──  inline keyboard button presses
    ▼
src/lib/ai/gemini.js  ──  streamCompletion() tool loop
    │
    ├── Vertex AI  (gemini-3.1-pro-preview / gemini-3-flash-preview)
    ├── Image AI   (gemini-2.5-flash-image / gemini-2.0-flash)
    ├── Cloud TTS  (Chirp3-HD voices)
    └── Cloud SQL  (PostgreSQL — memories, reminders, therapeutic notes, kv_store)
```

Cloud Scheduler calls `POST /cron` every minute to fire due reminders.

---

## 2. Infrastructure & Deployment

| Item | Value |
|---|---|
| Service name | `tenon-agent` |
| Region | `us-central1` |
| GCP project | `telegram-ai-agent-tenon` |
| Deploy command | `gcloud run deploy tenon-agent --source . --region us-central1 --project telegram-ai-agent-tenon` |
| Build command | `npm run build` (esbuild bundles to `dist/index.js`) |
| Node version | 22 |
| Cloud SQL instance | `telegram-ai-agent-tenon:us-central1:telegram-ai-agent-tenon` |
| Database name | `geminibot` |
| DB auth | IAM auth via Cloud SQL connector — no password |
| Service account | `65720571900-compute@developer.gserviceaccount.com` |
| Cron schedule | Every minute via Cloud Scheduler → `POST /cron` |
| Health check | `GET /health` → `{ status: 'ok', ts: <unix> }` |
| Command registration | `GET /register-commands` (one-time setup) |

### Key dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server / webhook receiver |
| `@google/genai` | Vertex AI SDK (Gemini text + image) |
| `@google-cloud/text-to-speech` | Cloud TTS SDK (ADC auth) |
| `@google-cloud/cloud-sql-connector` | IAM-authenticated Cloud SQL connection |
| `pg` | PostgreSQL client |
| `esbuild` | Bundler (dev dependency) |

---

## 3. Bot Commands

These are registered with Telegram via `setMyCommands` and shown in the bot's command menu.

### `/start`
Displays a welcome message identifying the active persona by name, and lists all available commands. This is the entry point for new conversations.

### `/persona`
Sends an inline keyboard with buttons for all 6 personas. Tapping a button immediately switches the active persona for that chat and confirms the change. The persona selection is persisted in the KV store per `chat_id`.

```
Keyboard layout:
[ ✨ Gemini ]         [ 🧠 Thinking Partner ]
[ 🟢 Mooncake ]      [ 🚀 HUE             ]
[ 💛 Tribore  ]
```

### `/clear`
Deletes the stored conversation history for the current chat and thread. History is per `chat_id` + `thread_id`, so forum topic threads are isolated. The AI will have no memory of previous messages after this command.

### `/memories`
Retrieves up to 40 saved memories from the database and displays them grouped by category. The output is split into two sections:

- **Saved Memories** — factual categories (preference, personal, work, etc.)
- **Therapeutic Observations** — therapeutic categories (pattern, schema, trigger, etc.)

Memories with `importance_score >= 2` are shown with a ⭐ prefix.

### `/forget`
Shows a confirmation inline keyboard before permanently deleting all memories for the current chat. Prevents accidental deletion.

---

## 4. Personas

Persona selection persists per `chat_id` in the KV store (key: `persona_{chatId}`). Falls back to `gemini` if no persona is set or the key is unrecognised.

### Gemini (default)
The general-purpose AI companion. Warm, curious, and capable across all domains. This is the default persona for new users. Handles all 14 tools.

### Thinking Partner
Analytical mode. Designed for deep reasoning, problem-solving, and structured thinking. Pushes back on assumptions and explores ideas rigorously.

### Mooncake
Honest, witty, and accountable. Has deep knowledge of neurodivergence (ADHD, bipolar type 2, anxiety), emotional support, and executive dysfunction. Applies AEDP, DBT, and attachment theory principles in a more casual, friend-like tone. Proactively flags recurring patterns and holds the user to stated goals.

### HUE
Deadpan and logical. Every sentence is clean and free of filler. Concise by design.

### Tribore
The primary therapeutic companion. Combines AEDP (primary framework), DBT, schema therapy, and attachment theory. Key behaviours:

- Retrieves therapeutic notes at the start of every conversation via `get_therapeutic_notes`
- Proactively saves observations mid-conversation via `save_therapeutic_note`
- Tracks homework, patterns, schemas, growth moments, and avoidance
- Relationship support mode: non-blaming, perspective-taking, constructive preparation
- Crisis protocol: if self-harm or escalating conflict is mentioned, directs to professional help and crisis lines (116 123 UK / 988 US)
- **Instruction text must never be modified**

### Nightfall
Wellness and pattern-recognition persona. Focuses on surfacing patterns in behaviour, mood, and habits using an "Active Data Mirror" philosophy — computational transparency, full evidence citation, consent-based accountability. **Instruction text must never be modified.**

---

## 5. AI & Model Configuration

### Text generation

| Setting | Value |
|---|---|
| Primary model | `gemini-3.1-pro-preview` |
| Fallback model | `gemini-3-flash-preview` |
| API provider | Vertex AI via `@google/genai` |
| Location | `global` (required for 3.x preview models) |
| Temperature | `1.0` (locked) |
| Max output tokens | `8192` |
| Tool config | `functionDeclarations` only — cannot be mixed with `googleSearch` |

The model runs in a `while (!isComplete)` tool loop in `handlers.js`. Each iteration calls `streamCompletion()`, which uses `generateContent` (non-streaming) to ensure complete thought signatures are available for multi-turn Gemini 3.x validation.

The loop:
1. Sends the conversation history + system prompt to Gemini
2. Collects text chunks and function call chunks
3. If function calls are present: executes them, appends results, loops again
4. If no function calls: sends the final text response to Telegram and exits

### Image generation

| Setting | Value |
|---|---|
| Primary model | `gemini-2.5-flash-image` |
| Fallback model | `gemini-2.0-flash` |
| Location | `us-central1` |
| Auth | Gemini Developer API key (`GEMINI_API_KEY`) |
| Response modalities | `TEXT` and `IMAGE` |
| Edit mode | Supported — pass the uploaded image as `inlineData` alongside the prompt |

### Retry/backoff

All model calls use a `withRetry()` wrapper: up to 3 attempts with exponential backoff (1s, 2s, 4s) on 503 and 429 errors. If the primary model exhausts retries, it falls back to the fallback model before throwing.

### Schema normalisation

Vertex AI requires lowercase type values in JSON schemas (`"object"` not `"OBJECT"`). A `normalizeSchema()` function in `gemini.js` normalises all 14 tool definitions at startup without touching individual tool files.

---

## 6. Tool System (14 Tools)

All tools are defined in `src/tools/` and registered in `src/tools/index.js`. They are exposed to Gemini as `functionDeclarations`. The AI decides when to call them based on context.

### `save_memory`
Saves a long-term fact or observation about the user to the `memories` table.

- **Categories:** `preference`, `personal`, `work`, `hobby`, `identity`, `relationship`, `health`, `habit`, `pattern`, `trigger`, `avoidance`, `schema`, `growth`, `coping`, `insight`
- **Importance:** `1` = normal fact, `2` = notable therapeutic observation, `3` = significant pattern or breakthrough
- The AI is instructed to use importance 2 or 3 for therapeutic observations representing significant patterns

### `reminder`
Creates a reminder entry in the `reminders` table. The cron job checks for due reminders every minute and delivers them as both a text message and a voice note.

- **Recurrence:** `none`, `daily`, `weekly`, `monthly`
- Context metadata (persona key, first name, reason) is stored as JSON in the `metadata` column
- Group reminders address the recipient by name; private reminders omit the name

### `reaction`
Sends an emoji reaction to a specific Telegram message using `setMessageReaction`.

- Requires `replyToMessageId` in the tool execution context
- Only the first emoji is used if an array is passed (Telegram limitation)

### `send_voice_note`
Converts text to speech using Cloud TTS and sends it as an OGG Opus voice message. Voice selection is based on the active persona. The actual execution is handled directly in `handlers.js` because it requires both TTS and Telegram API access.

### `pin`
Pins a message in the chat using `pinChatMessage`. Defaults to pinning the user's triggering message. Silent pin (no notification).

### `generate_image`
Generates a new image or edits an existing uploaded image using the Gemini image model.

- If `edit_mode: true` and the user sent an image in the same message, the uploaded image is passed as `inlineData` alongside the prompt
- Generated images are sent as photos with 🔄 Regenerate and 🗑️ Delete inline buttons
- The last prompt is cached in KV (`last_img_{chatId}_{threadId}`, TTL 24h) to support regeneration

### `poll`
Sends a Telegram native poll. The AI constructs the question and options. Note: `poll_answer` webhooks are unreliable — inline keyboard buttons are preferred for interactive decisions.

### `location`
Sends a map pin (latitude/longitude) in the Telegram chat using `sendLocation`.

### `checklist`
Sends a native Telegram checklist (Bot API 9.5+) via `sendChecklist`. Each task becomes a tappable button. The callback handler processes `chk|{index}|{title}` taps to toggle task completion with strikethrough formatting and a progress counter.

### `draft`
Sends a message using the Telegram `sendMessage` API with `sendMessageDraft` semantics (streaming HTML message). Falls back to plain text if HTML parse fails.

### `quote`
Sends a formatted quoted message. Used for emphasis or citation-style responses.

### `send_with_effect`
Sends a message with a full-screen animated Telegram Premium effect.

**Built-in effects:**

| Name | Emoji | When to use |
|---|---|---|
| `hearts` | ❤️ | Emotional breakthroughs, love |
| `like` | 👍 | Approval, encouragement |
| `dislike` | 👎 | Playful disapproval |
| `fire` | 🔥 | Hype, excitement |
| `confetti` | 🎉 | Celebrations, achievements, milestones |
| `poop` | 💩 | Playful teasing |

Additional premium effects can be discovered dynamically when a user sends a message with a Telegram Premium effect. The effect ID is stored in KV as `effect_emoji_{emoji}` and becomes available for future use. Effect resolution order: name → emoji → ID → KV lookup.

### `save_therapeutic_note`
Saves a typed therapeutic observation to the `therapeutic_notes` table. Used by Tribore (and optionally other personas) to maintain continuity across sessions.

**Note types:**

| Type | Purpose |
|---|---|
| `pattern` | Recurring emotional, behavioural, or relationship dynamics |
| `schema` | Core schema activations (abandonment, defectiveness, etc.) |
| `avoidance` | Topics or emotions the user deflects from or minimises |
| `homework` | Exercises or reflections suggested, to be followed up later |
| `session` | Key themes, breakthroughs, or shifts from a conversation |
| `trigger` | Identified emotional triggers and their context |
| `growth` | Moments of vulnerability, insight, or courage |

### `get_therapeutic_notes`
Retrieves previous therapeutic notes. Tribore calls this at the start of every conversation to reload context from prior sessions. Can filter by `note_type` and `limit`.

---

## 7. Callback Actions

Inline keyboard buttons fire `callback_query` updates. All callbacks answer with `answerCallbackQuery` immediately to dismiss the loading state.

| `callback_data` | Source | Behaviour |
|---|---|---|
| `set_persona_{key}` | `/persona` keyboard | Saves persona key to KV; removes the keyboard from the selector message; sends a confirmation message |
| `confirm_forget` | `/forget` keyboard | Calls `deleteAllMemories()`; edits the confirmation message to confirm deletion |
| `cancel_forget` | `/forget` keyboard | Edits the confirmation message to confirm memories were kept |
| `action_voice` | 🔊 button on text replies | Generates TTS from the bot message text using the current persona's voice; sends as OGG voice message; removes the button row |
| `action_delete_msg` | 🗑️ button on replies and images | Deletes the bot's message |
| `img_regen` | 🔄 button on generated images | Reads the last image prompt from KV (`last_img_{chatId}_{threadId}`); generates a new image with the same prompt |
| `chk\|{index}\|{title}` | Checklist task buttons | Toggles the tapped task's completion state (strikethrough text); updates the progress line (e.g. "2 / 5 done") at the top of the checklist |

---

## 8. Media Input Handling

The bot accepts the following media types in incoming messages:

| Type | Mime hint |
|---|---|
| Photo | `image/jpeg` |
| Voice message | `audio/ogg` (or message mime type) |
| Audio file | `audio/mpeg` (or message mime type) |
| Video note (circle video) | `video/mp4` |
| Document | Original mime type (if image, audio, video, PDF, or text) |
| Static sticker | `image/webp` |

All media is downloaded via `downloadFile()`, which enforces a **20 MB maximum file size**. The file is base64-encoded and passed to Gemini as an `inlineData` part alongside the text. If no text is present, a default prompt ("Describe or respond to this media.") is prepended.

Animated and video stickers are not supported (cannot be processed as raster images).

Binary `inlineData` is replaced with the placeholder `[Media]` before conversation history is written to the KV store, to avoid bloating storage.

---

## 9. Memory System

Memories are stored in the `memories` table (PostgreSQL) and injected into every system prompt.

### Categories

**Factual:** `preference`, `personal`, `work`, `hobby`, `identity`, `relationship`, `health`, `habit`

**Therapeutic:** `pattern`, `trigger`, `avoidance`, `schema`, `growth`, `coping`, `insight`

### Importance scores

| Score | Meaning |
|---|---|
| `1` | Normal everyday fact |
| `2` | Notable therapeutic observation |
| `3` | Significant pattern or breakthrough |

### How memories appear in the system prompt

`getFormattedContext()` fetches up to 40 memories, ordered by `importance_score DESC, created_at DESC`, and formats them into two blocks:

```
Facts:
- [preference] Likes dark roast coffee
- [work] Senior product manager at Acme

Therapeutic observations:
- [pattern] Tends to catastrophise when tired (3d ago)
- [schema] Core narrative of not being enough (1w ago)
```

Therapeutic memories include a relative age string (today / yesterday / Xd ago / Xw ago / Xmo ago) so the AI has temporal context.

### `/memories` display

When the user runs `/memories`, memories are split into Factual and Therapeutic Observations sections in the Telegram message. Therapeutic memories with `importance_score >= 2` are prefixed with ⭐.

---

## 10. Therapeutic Notes System

A separate, richer storage system for Tribore's session observations. Unlike the flat `memories` table, therapeutic notes have a typed schema and tag support.

### Storage

Table: `therapeutic_notes`. Columns: `chat_id`, `note_type`, `content`, `tags` (JSON array), `created_at`.

Allowed `note_type` values: `pattern`, `schema`, `avoidance`, `homework`, `session`, `trigger`, `growth`.

### Usage pattern (Tribore)

1. At the start of every conversation: calls `get_therapeutic_notes` to reload context
2. Mid-conversation: calls `save_therapeutic_note` as observations arise — does not wait until the end
3. Saves homework when suggesting exercises, so it can follow up in future sessions with: *"Last time I suggested [X]. Did you get a chance to try it?"*

### Design philosophy

The therapeutic notes system implements the "Active Data Mirror" approach:

- Present raw evidence with full transparency (exact dates, tags, context)
- Return agency to the user — the AI does not impose interpretations
- Coping menu: surface multiple past strategies rather than priming one solution
- Consent-based accountability: negotiate pressure rather than apply it autonomously

---

## 11. Reminder System

### Creating reminders

The AI calls the `reminder` tool with a natural-language-derived `due_at` Unix timestamp and optional recurrence. The `context` object includes the `firstName`, `reason`, and `persona` key — stored as JSON in the `metadata` column.

The Unix timestamp is anchored by `Unix Anchor: ${Math.floor(Date.now() / 1000)}` in the system prompt (alongside London time), so the AI can calculate precise future timestamps without ambiguity.

### Delivery (cron)

Cloud Scheduler calls `POST /cron` every minute. The endpoint:

1. Responds `200 OK` immediately (avoids Scheduler timeout)
2. In `setImmediate`: queries `getDueReminders()` for all `pending` rows where `due_at <= now`
3. Processes in batches of 5
4. Each reminder fires in parallel: text message + TTS voice note
5. Marks delivered reminders as `status = 'delivered'`
6. Recalculates and updates `due_at` for recurring reminders

### Recurrence

| Type | Next due |
|---|---|
| `daily` | +86400 seconds |
| `weekly` | +604800 seconds |
| `monthly` | Calendar month increment via `Date.setMonth()` |

### Message format

**Private chat:**
```
⏰ Reminder: [text]

[Context: reason]  ← expandable blockquote
```

**Group chat:**
```
⏰ [FirstName], reminder: [text]

[Context: reason]  ← expandable blockquote
```

---

## 12. Text-to-Speech (TTS)

Uses Google Cloud Text-to-Speech SDK (`@google-cloud/text-to-speech`) with ADC authentication. Output: OGG Opus, 24 kHz.

### Voice mapping (per persona)

| Persona key | Voice |
|---|---|
| `gemini` | `en-US-Chirp3-HD-Gacrux` |
| `thinking_partner` | `en-US-Chirp3-HD-Vindemiatrix` |
| `mooncake` | `en-US-Chirp3-HD-Vindemiatrix` |
| `hue` | `en-US-Chirp3-HD-Zubenelgenubi` |
| `tribore` | `en-US-Chirp3-HD-Gacrux` *(verify against live file)* |
| `default` (fallback) | `en-US-Chirp3-HD-Gacrux` |

TTS is triggered in three places:
1. When the AI calls `send_voice_note` tool
2. When the user taps the 🔊 button on a text reply (callback `action_voice`)
3. When a reminder fires (cron — always sends both text and voice)

---

## 13. Database Schema

PostgreSQL via Cloud SQL. IAM auth — no password. Connection pool: max 5.

### `user_profiles`
Lazily populated user metadata. Not required for the bot to function — memories and reminders use `chat_id` directly without a foreign key.

```sql
chat_id                  BIGINT PRIMARY KEY
first_name               TEXT
communication_preference TEXT DEFAULT 'friendly'
known_hobbies            TEXT
core_traits              TEXT
updated_at               TIMESTAMPTZ DEFAULT NOW()
```

### `memories`
All long-term facts and therapeutic observations.

```sql
id               SERIAL PRIMARY KEY
chat_id          BIGINT NOT NULL
category         TEXT NOT NULL
fact             TEXT NOT NULL
importance_score INTEGER DEFAULT 1
created_at       TIMESTAMPTZ DEFAULT NOW()
```

### `reminders`

```sql
id                  SERIAL PRIMARY KEY
creator_chat_id     BIGINT NOT NULL
recipient_chat_id   BIGINT NOT NULL
text                TEXT NOT NULL
due_at              BIGINT NOT NULL        -- Unix timestamp
original_message_id BIGINT
recurrence_type     TEXT DEFAULT 'none'   -- none / daily / weekly / monthly
thread_id           TEXT DEFAULT 'default'
status              TEXT DEFAULT 'pending' -- pending / delivered
metadata            TEXT DEFAULT '{}'      -- JSON: firstName, reason, persona
created_at          TIMESTAMPTZ DEFAULT NOW()
updated_at          TIMESTAMPTZ DEFAULT NOW()
```

### `therapeutic_notes`

```sql
id         SERIAL PRIMARY KEY
chat_id    TEXT NOT NULL
note_type  TEXT NOT NULL  -- pattern / schema / avoidance / homework / session / trigger / growth
content    TEXT NOT NULL
tags       TEXT DEFAULT '[]'   -- JSON array of strings
created_at TEXT NOT NULL       -- ISO string from new Date().toISOString()
```

### `kv_store`
Replaces Cloudflare KV. Supports TTL via `expires_at`.

```sql
key        TEXT PRIMARY KEY
value      TEXT NOT NULL
expires_at TIMESTAMPTZ        -- NULL = no expiry
updated_at TIMESTAMPTZ DEFAULT NOW()
```

### `chat_summaries`
Reserved for future monthly memory consolidation. Not currently written to.

```sql
id           SERIAL PRIMARY KEY
chat_id      BIGINT NOT NULL
summary_text TEXT NOT NULL
date_range   TEXT NOT NULL
created_at   TIMESTAMPTZ DEFAULT NOW()
```

---

## 14. KV Store

The KV store is emulated via the `kv_store` PostgreSQL table. A D1-compatible shim in `src/lib/env.js` exposes `env.CHAT_KV.get()`, `.put()`, and `.delete()` so all service/tool code remains unchanged from the original Cloudflare Workers design.

### Keys in use

| Key pattern | Contents | TTL |
|---|---|---|
| `persona_{chatId}` | Persona key string (e.g. `tribore`) | No expiry |
| `chat_{chatId}_{threadId}` | JSON array — last 24 conversation turns | 7 days |
| `last_img_{chatId}_{threadId}` | JSON `{ prompt }` — last image generation prompt | 24 hours |
| `biz_conn_{userId}` | Telegram Business connection ID | 30 days |
| `effect_emoji_{emoji}` | Premium effect ID for a discovered emoji | No expiry |

---

## 15. Conversation History

History is stored per `chat_id` + `thread_id`, so each Telegram forum topic thread has its own isolated history.

### Limits

| Setting | Value |
|---|---|
| Max turns stored | 24 (last 24 entries after trimming) |
| TTL | 7 days |
| Max file download | 20 MB |

### What is stored

- Text parts
- `functionCall` and `functionResponse` parts (needed for Gemini 3.x multi-turn tool loop validation)
- Thought signature parts (required for Gemini 3.x multi-turn validation — stripped by `includeThoughts: false` default)
- `inlineData` (binary media) is replaced with `{ text: "[Media]" }` before storage

### History trimming

If the first entry after slicing is a model turn, it is removed. Gemini 3.x requires the first history entry to be a user turn.

### Reply context

If the user replies to a message, a context prefix is injected into the user parts:

```
[User is replying to {name}: "{quoted text, max 500 chars}"]
```

---

## 16. Telegram API Capabilities

The following Telegram Bot API methods are in use:

| Method | Used for |
|---|---|
| `sendMessage` | All text replies (with HTML parse mode) |
| `sendVoice` | OGG Opus audio messages |
| `sendPhoto` | Generated images |
| `sendDocument` | File uploads |
| `sendChecklist` | Native checklists (Bot API 9.5) |
| `sendPoll` | Polls |
| `sendLocation` | Map pins |
| `sendChatAction` | Typing / upload_voice / upload_photo indicators |
| `setMessageReaction` | Emoji reactions |
| `pinChatMessage` | Pinning messages (silent) |
| `deleteMessage` | Deleting bot messages |
| `editMessageText` | Editing existing messages |
| `editMessageReplyMarkup` | Removing/updating inline keyboards |
| `copyMessage` | Copying messages |
| `forwardMessage` | Forwarding messages |
| `getFile` / file download | Downloading user-uploaded media |
| `setMyCommands` | Registering bot command menu |
| `answerCallbackQuery` | Dismissing inline button loading states |

### HTML formatting

All text replies use HTML parse mode. A `sanitizeTelegramHTML()` function cleans unsafe tags before sending. If HTML parsing fails, the bot retries with all tags stripped (plain text fallback).

### Thread support

All sending functions accept a `threadId` parameter. When `threadId !== "default"`, `message_thread_id` is included in the payload, enabling full Telegram forum topic support.

---

## 17. System Prompt Construction

Each message handler builds the system prompt fresh before calling Gemini:

```
{persona.instruction}

{FORMATTING_RULES}

User: {firstName}
London Time: {toLocaleString('en-GB', { timeZone: 'Europe/London' })}
Unix Anchor: {Math.floor(Date.now() / 1000)}

MEMORY:
{getFormattedContext(env, chatId)}
```

The Unix Anchor is critical for the reminder tool — it gives Gemini an accurate reference point for calculating future timestamps.

`FORMATTING_RULES` is a shared constant in `src/config/personas.js` that instructs the AI on Telegram HTML formatting, message length, and tone.

---

## 18. Business Account Support

The bot supports Telegram Business connections. When a business connection event is received:

- `is_enabled` → stores `biz_conn_{userId}` = connection ID in KV (TTL 30 days)
- `!is_enabled` → deletes the KV entry

Business messages are processed identically to regular messages via `handleMessage()`. The `business_connection_id` is refreshed on every incoming business message to keep it current.

---

## 19. Key Architectural Constraints & Learnings

These are design decisions and constraints that must be respected when extending the bot.

| Constraint | Reason |
|---|---|
| Do not pass `MENTAL_HEALTH_DIRECTIVE` to `generateShortResponse` in callbacks | Causes the Flash model to exhaust its thinking budget and return truncated/empty responses |
| Tool schema types must be lowercase | Vertex AI rejects uppercase (e.g. `"OBJECT"`); normalised automatically at startup |
| Gemini 3.x models require `location: 'global'` | Regional endpoints (e.g. `us-central1`) are not supported for preview models |
| Do not mix `functionDeclarations` with `googleSearch` tools | Not supported in Gemini 3.x preview |
| Do not use `includeThoughts: true` | Causes internal reasoning tokens to leak into user-facing responses |
| Polls do not fire `poll_answer` webhooks reliably | Use inline keyboard buttons for interactive decisions instead |
| `sendMessageDraft` is a streaming send method, not a draft pre-fill | It sends the message immediately; the name is misleading |
| Reactions require `replyToMessageId` in execution context | The context must be passed correctly from the handler |
| `lastBotMessageId` is null during tool execution | Do not rely on it for pin targets; pin defaults to user's message |
| Animated/video stickers cannot be processed | Gemini generates raster images only; animated formats are unsupported |
| Context caching requires ~4096 token minimum | Gemini 3/3.1 models enforce this threshold |
| Application-layer encryption was evaluated and rejected | Cloud SQL IAM auth + `chat_id` isolation is the security boundary |

---

## 20. Pending / Planned Features

These are designed and agreed upon but **not yet implemented** in the codebase.

### Weekly report system (`handleWeeklyReport`)
A structured weekly summary with three sections: Observation, Data Audit, and a single AEDP-aligned hand-off question. Reports are saved via `memoryStore.saveMemory()` with `importance_score = 2`, feeding into future monthly memory consolidation.

### Accountability nudge system (`handleAccountabilityNudge`)
Weaves recent therapeutic homework (from `therapeutic_notes` where `note_type = 'homework'`) with the latest weekly insight to generate a personalised nudge.

### Telegram inline mode
Enable via BotFather (`/setinline` → prompt: `Ask Tenon anything...`). Allows the bot to respond to queries from any Telegram chat without being added as a member.

### Multi-user architecture
The `user_id` column is already present on all DB tables to avoid costly retrofitting. All service functions accept `userId` as a parameter (even if hardcoded today) in preparation for a paid multi-user tier.

### Monthly memory consolidation
Uses `chat_summaries` table (already in schema). Aggregates high-importance memories and therapeutic notes into a rolling monthly summary, reducing context bloat over time.

---

*Last updated: April 2026*
