-- ==========================================
-- XARIDOTIS DATABASE SCHEMA
-- All personal data keyed by user_id (Telegram from.id)
-- chat_id used only for delivery targets
-- Matches Eukara schema for future convergence
-- ==========================================

-- 1. USER PROFILES (per-user identity + persona evolution)
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    language_code TEXT DEFAULT 'en',
    timezone TEXT DEFAULT 'Europe/London',
    communication_preference TEXT DEFAULT 'friendly',
    known_hobbies TEXT,
    core_traits TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. PERSONA CONFIG (per-user, per-persona personality settings)
-- Composite PK: each user gets their own copy of each persona.
-- Built-in personas are seeded on first contact; users can override or add custom ones.
CREATE TABLE IF NOT EXISTS persona_config (
    user_id INTEGER NOT NULL,
    persona_key TEXT NOT NULL,
    display_name TEXT,
    is_custom INTEGER DEFAULT 0,
    base_persona TEXT DEFAULT 'xaridotis',
    tone TEXT DEFAULT 'warm',
    formality TEXT DEFAULT 'casual',
    humour_level TEXT DEFAULT 'moderate',
    emoji_style TEXT DEFAULT 'moderate',
    therapeutic_approach TEXT DEFAULT 'supportive',
    voice_name TEXT,
    voice_locale TEXT DEFAULT 'en-US',
    custom_instruction TEXT,
    topics_of_interest TEXT,
    communication_notes TEXT,
    evolved_traits TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, persona_key),
    FOREIGN KEY(user_id) REFERENCES user_profiles(user_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_user ON persona_config(user_id);

-- 3. MEMORIES (long-term facts, keyed by user_id)
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    fact TEXT NOT NULL,
    importance_score INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES user_profiles(user_id)
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);

-- 4. REMINDERS (user_id = owner, chat_id = where to deliver)
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    original_message_id INTEGER,
    recurrence_type TEXT DEFAULT 'none',
    thread_id TEXT DEFAULT 'default',
    status TEXT DEFAULT 'pending',
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, status);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);

-- 5. CONVERSATION SUMMARIES
CREATE TABLE IF NOT EXISTS chat_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    date_range TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES user_profiles(user_id)
);

-- 6. EPISODES (CoALA episodic memory)
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    episode_type TEXT NOT NULL,
    trigger_context TEXT,
    emotions TEXT,
    intervention TEXT,
    outcome TEXT,
    lesson TEXT,
    mood_score INTEGER,
    related_memory_ids TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id);
CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(user_id, episode_type);
CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodes(user_id, created_at);

-- 7. KNOWLEDGE GRAPH (GraphRAG triples)
CREATE TABLE IF NOT EXISTS knowledge_graph (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    context TEXT,
    confidence REAL DEFAULT 1.0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kg_subject ON knowledge_graph(user_id, subject);
CREATE INDEX IF NOT EXISTS idx_kg_object ON knowledge_graph(user_id, object);

-- 8. MOOD JOURNAL
CREATE TABLE IF NOT EXISTS mood_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'evening',
    mood_score INTEGER,
    emotions TEXT,
    sleep_hours REAL,
    sleep_quality TEXT,
    medication_taken INTEGER DEFAULT 0,
    medication_time TEXT,
    medication_notes TEXT,
    activities TEXT,
    note TEXT,
    ai_observation TEXT,
    photo_r2_key TEXT,
    clinical_tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mood_user_date ON mood_journal(user_id, date);
