// Bot Architecture Summary
// This file is read by the self-improvement advisor to understand the bot's capabilities.
// It is NOT executable code. It is a reference document for the AI to reason about.
// Last updated: 2026-04-11

export const ARCHITECTURE_SUMMARY = `
=== GEMINI BOT ARCHITECTURE SUMMARY ===

PLATFORM: Cloudflare Workers + D1 (SQLite) + KV + R2 + Vectorize + AI Gateway
AI MODEL: Google Gemini (gemini-3.1-pro-preview primary, gemini-3-flash-preview fallback)
MESSAGING: Telegram Bot API (Bot API 9.6)

PERSONAS:
- Tenon: Direct, logical, dry humour, voice of reason
- Nightfall: Warm, therapeutic, AEDP/DBT/Schema therapy frameworks
- Tribore: Flamboyant, theatrical, unexpectedly insightful

CORE FEATURES:
- Multi-persona system with per-chat switching
- Voice input/output (Gemini multimodal + Google Cloud TTS)
- Image generation and editing (Gemini Nano Banana Pro)
- Semantic memory (D1 + Vectorize dual-write)
- Conversation history in KV (24 turns, 7-day TTL)
- Streaming responses via sendMessageDraft
- Media handling (photos, voice, video, documents, stickers)
- Large file support via Google Files API (>15MB threshold)

MENTAL HEALTH SYSTEM:
- Mood journal (D1 mood_journal table, 0-10 bipolar scale)
- Three daily health check-ins (morning 08:30, midday 13:00, evening 20:30)
- Medication nudge system (30-min timer-based)
- Crisis detection (scores 0-1 and 9-10)
- Positive/negative emotion buttons after mood score
- Adaptive survival checklists (auto-deploy at scores 2-3 and 8)
- Voice biomarker analysis (prosody tracking)
- Clinical references: NICE CG185/NG193, NG87, BAP, APA, WHO

PROACTIVE FEATURES:
- Weekly Mental Health Report (Sunday 20:00, transparent data mirror)
- Mid-Week Accountability Nudge (Wednesday 16:00, weaves weekly insights)
- Monthly Memory Consolidation / REM Sleep (1st of month 03:00)
- Spontaneous "Thinking of You" outreach (random daily, 5% chance)
- Weekly Curiosity Digest (Saturday 10:00, Google Search grounding)
- Autonomous Research Loop (Tuesday/Friday 04:00, single domain deep search)
- Proactive trigger interception via Vectorize (>75% relevance alerts)

SECOND BRAIN:
- Brain dump synthesis and structured saving
- Smart reminder timing (infer delay for casual tasks)
- Idea development and cross-referencing
- Proactive accountability (pattern detection across conversations)
- Subjective opinions on user's hobbies

TOOLS AVAILABLE TO AI:
- save_memory, get_memories (categories: preference, personal, hobby, pattern, trigger, schema, growth, coping, insight, homework, idea, brain_dump, discovery)
- set_reminder (smart timing, recurrence support)
- log_mood_entry (partial upsert, next_step feedback)
- get_mood_history
- react_to_message (73 Telegram-supported emojis)
- send_voice_note
- pin_message
- generate_image (Nano Banana Pro + Flash fallback)
- send_poll
- create_checklist
- web_search (Google Search grounding)

TELEGRAM FEATURES USED:
- Inline keyboards, callback queries
- sendMessageDraft (streaming)
- Reactions, polls, checklists
- Voice notes, photos, documents
- Link preview suppression
- Reply parameters with quote
- Message effects
- Command menu registration

TELEGRAM FEATURES NOT YET USED:
- date_time message entity (timezone-aware timestamps)
- Button styling (Bot API 9.4 colours)
- Custom emoji on buttons
- Mini Apps (WebAppInfo)
- Forum topics in private chats
- Member tags
- setMyProfilePhoto

DATABASE TABLES:
- mood_journal (19 columns, mood tracking)
- users (6 columns, identity)
- reminders (13 columns, scheduling)
- memories (7 columns, semantic memory)
- chat_summaries (5 columns)
- user_profiles (9 columns)

KNOWN LIMITATIONS:
- Hardcoded Europe/London timezone (no travel support)
- generateShortResponse uses Flash (Pro causes token exhaustion)
- D1 can timeout under heavy concurrent load
- No end-to-end encryption for therapeutic data
- No GDPR-compliant data jurisdiction yet
`;
