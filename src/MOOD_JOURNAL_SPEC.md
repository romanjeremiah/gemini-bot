# Mental Health & Mood Journal System - Design Spec
## For: Gemini Telegram Bot (gemini-bot)

### Overview
A comprehensive mental health tracking system integrated into all personas,
with structured daily check-ins that auto-switch to Nightfall persona.

---

## 1. Bipolar Mood Scale (0-10)

| Score | Label | Description |
|-------|-------|-------------|
| 0 | Severe Depression | Endless suicidal thoughts, no way out, no movement. Everything is bleak. |
| 1 | Severe Depression | Feelings of hopelessness and guilt. Thoughts of suicide, little movement. |
| 2 | Mild/Moderate Depression | Slow thinking, no appetite, need to be alone, excessive/disturbed sleep. Everything feels like a struggle. |
| 3 | Mild/Moderate Depression | Feelings of panic and anxiety, concentration difficult, memory poor, some comfort in routine. |
| 4 | Balanced | Slight withdrawal from social situations, less concentration, slight agitation. |
| 5 | Balanced | Mood in balance, making good decisions. Life is going well, outlook is good. |
| 6 | Balanced | Self-esteem good, optimistic, sociable and articulate. Making good decisions, getting work done. |
| 7 | Hypomania | Very productive, charming and talkative. Doing everything in excess. |
| 8 | Hypomania | Inflated self-esteem, rapid thoughts and speech. Doing too many things at once, not finishing tasks. |
| 9 | Mania | Lost touch with reality, incoherent, no sleep. Feeling paranoid and vindictive. Reckless behaviour. |
| 10 | Mania | Total loss of judgement, out-of-control spending, religious delusions and hallucinations. |

## 2. Emotion Categories

### Positive
lively, grateful, proud, calm, witty, relaxed, energetic, amused, motivated,
empathetic, decisive, spirited, aroused, inspired, curious, satisfied, excited,
brave, affectionate, fearless, happy, carefree, joyful, sexy, confident,
in love, blissful

### Negative
devastated, miserable, awkward, empty, paranoid, frustrated, horrified, scared,
lost, angry, disgusted, depressed, sad, perplexed, sick, anxious, annoyed,
insecure, lonely, offended, misunderstood, confused, tired, bored, envious,
nervous, disappointed

---

## 3. Daily Check-in Schedule (3 touchpoints, all auto-switch to Nightfall)

### Morning (~8-9am London time)
- Natural "good morning" greeting
- Ask about sleep quality and hours
- Remind about morning medication (bipolar + ADHD)
- Brief mood check (how are you feeling this morning?)
- Detect mood from response, log automatically

### Midday (~12:30-1:30pm London time)
- Check: ADHD medication taken?
- Check: Anxiety medication taken?
- Brief mood pulse (how's the day going?)
- Can use Telegram polls for quick structured input

### Evening (~8-9pm London time)
- Full mood journal entry:
  - Mood score (0-10 bipolar scale)
  - Emotions (from the positive/negative lists)
  - Sleep hours (from morning, confirm)
  - Medication adherence summary for the day
  - Activities done today (can be auto-detected from conversations)
  - Free-text note
  - Ask for a photo of the day
- Analyse conversations from throughout the day for mood patterns
- Provide brief reflection/observation based on the day's data

### Auto-switch to Nightfall behaviour:
- When cron triggers a health check-in, temporarily override active persona to Nightfall
- Nightfall handles the check-in conversation
- After check-in is complete, persona reverts to whatever was active before
- Flag in KV: `health_checkin_active_{chatId}` with TTL

---

## 4. Database Schema: mood_journal table

```sql
CREATE TABLE IF NOT EXISTS mood_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,                    -- YYYY-MM-DD, one primary entry per day
  entry_type TEXT NOT NULL DEFAULT 'evening',  -- 'morning', 'midday', 'evening'
  mood_score INTEGER,                    -- 0-10 bipolar scale
  mood_label TEXT,                       -- 'severe_depression', 'mild_depression', 'balanced', 'hypomania', 'mania'
  emotions TEXT,                         -- JSON array of emotion strings
  sleep_hours REAL,                      -- e.g. 7.5
  sleep_quality TEXT,                    -- 'poor', 'fair', 'good', 'excellent'
  medication_taken INTEGER DEFAULT 0,    -- boolean
  medication_time TEXT,                  -- e.g. '08:30'
  medication_notes TEXT,                 -- which meds, late/on-time
  activities TEXT,                       -- JSON array of activity strings
  note TEXT,                             -- free-text journal note
  photo_r2_key TEXT,                     -- R2 object key if photo uploaded
  ai_observation TEXT,                   -- Nightfall's analysis/observation for this entry
  context_summary TEXT,                  -- auto-generated from day's conversations
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mood_journal_chat_date ON mood_journal(chat_id, date);
CREATE INDEX idx_mood_journal_chat_type ON mood_journal(chat_id, entry_type);
```

---

## 5. Gemini Tools

### log_mood_entry
- Called by AI when mood data is detected (explicit or natural conversation)
- Partial updates allowed (morning logs sleep, evening adds mood score)
- Upserts by chat_id + date + entry_type

### get_mood_history
- Retrieves entries for analysis
- Accepts: date_range, entry_type filter
- Returns structured data for trend analysis

### analyse_mood_trends
- Triggers Gemini code execution to compute:
  - Mood score trends over 7/14/30 days
  - Sleep vs mood correlation
  - Medication adherence rate
  - Emotion frequency analysis
- Must cite clinical frameworks (NICE bipolar guidelines, etc.)

---

## 6. General Mental Health Rules (all personas, in FORMATTING_RULES or shared block)

```
MENTAL HEALTH INTELLIGENCE:
You have deep knowledge of mental health, grounded in evidence-based practice.
When discussing mental health topics:
- Use only information from trusted sources: NHS, NICE guidelines, APA, WHO,
  peer-reviewed research, established clinical frameworks.
- Cite sources when making clinical claims or recommendations.
- Understand and reference the bipolar mood scale (0-10) used in this system.
- Be alert to mood shifts in conversation. If you detect signs of elevated or
  depressed mood, note it using the save_therapeutic_note tool.
- Never diagnose. Frame observations as patterns, not labels.
- Distinguish between clinical information and personal support.
- If mood score reaches 0-1 (severe depression with suicidal ideation) or
  9-10 (full mania), flag this prominently and suggest professional contact.
- For ADHD-related discussions, reference evidence-based strategies from
  NICE guidelines (NG87) and APA practice guidelines.
- For bipolar-related discussions, reference NICE guidelines (CG185/NG193)
  and BAP (British Association for Psychopharmacology) guidelines.
```

---

## 7. Cron Schedule Updates

Current: `* * * * *` (every minute, for reminders)

Additional scheduled tasks (check via hour/minute in the handler):
- 08:30 London time → Morning check-in
- 13:00 London time → Midday medication check
- 20:30 London time → Evening mood journal

These send a message as Nightfall to the owner's chat, regardless of active persona.
Store `health_checkin_active_{chatId}` in KV so subsequent messages
in that conversation are handled by Nightfall until the check-in completes.

---

## 8. Interactive Features

- Use Telegram polls for quick mood scoring (0-10 slider equivalent)
- Use inline keyboards for emotion selection (positive/negative toggle)
- Use checklists for medication tracking
- Photo upload stored in R2 with mood_journal entry reference

---

## 9. Files to Create/Modify

### New files:
- src/services/moodStore.js (CRUD for mood_journal table)
- src/tools/mood.js (log_mood_entry, get_mood_history, analyse_mood_trends tools)

### Modified files:
- src/config/personas.js (add mental health rules to FORMATTING_RULES)
- src/tools/index.js (register new mood tools)
- src/index.js (add health check-in cron logic)
- src/bot/handlers.js (detect Nightfall auto-switch for health check-ins)
- Migration SQL for mood_journal table
