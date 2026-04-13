-- ==========================================
-- GEMINI BOT DATABASE SCHEMA
-- Matches live D1 database as of April 2026
-- ==========================================

-- 1. USER PROFILES
CREATE TABLE IF NOT EXISTS user_profiles (
    chat_id INTEGER PRIMARY KEY,
    first_name TEXT,
    communication_preference TEXT DEFAULT 'friendly',
    known_hobbies TEXT,
    core_traits TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. MEMORIES (long-term facts about the user)
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    fact TEXT NOT NULL,
    importance_score INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES user_profiles(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
CREATE INDEX IF NOT EXISTS idx_memories_chat_category ON memories(chat_id, category);

-- 3. REMINDERS
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_chat_id INTEGER NOT NULL,
    recipient_chat_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    original_message_id INTEGER,
    recurrence_type TEXT DEFAULT 'none',
    thread_id TEXT DEFAULT 'default',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, status);

-- 4. CONVERSATION SUMMARIES (future use)
CREATE TABLE IF NOT EXISTS chat_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    date_range TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES user_profiles(chat_id)
);

-- 5. EPISODES (CoALA episodic memory — structured records of significant interactions)
-- Captures: what triggered the episode, what emotions were present, what intervention was tried,
-- what the outcome was, and what lesson was learned. This enables Xaridotis to recall
-- "last time this happened, we tried X and it worked/didn't work."
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    episode_type TEXT NOT NULL,        -- 'crisis', 'breakthrough', 'pattern', 'checkin', 'conversation'
    trigger_context TEXT,              -- what prompted this episode
    emotions TEXT,                     -- JSON array of emotions present
    intervention TEXT,                 -- what Xaridotis did/suggested
    outcome TEXT,                      -- how it resolved (positive/negative/neutral/pending)
    lesson TEXT,                       -- what was learned for future reference
    mood_score INTEGER,                -- mood score at time of episode (if available)
    related_memory_ids TEXT,           -- JSON array of memory IDs referenced
    metadata TEXT,                     -- JSON for any additional structured data
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id);
CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(chat_id, episode_type);
CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodes(chat_id, created_at);

-- 6. KNOWLEDGE GRAPH (GraphRAG — relational triples for reasoning)
-- Stores Subject-Predicate-Object relationships enabling multi-hop reasoning:
-- "Roman enjoys coffee" + "coffee is stimulant" = context about overstimulation
CREATE TABLE IF NOT EXISTS knowledge_graph (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    subject TEXT NOT NULL,           -- e.g., 'Roman', 'coffee', 'ADHD medication'
    predicate TEXT NOT NULL,         -- e.g., 'enjoys', 'causes', 'helps with'
    object TEXT NOT NULL,            -- e.g., 'drone videography', 'insomnia', 'focus'
    context TEXT,                    -- optional metadata or source sentence
    confidence REAL DEFAULT 1.0,    -- 0.0 to 1.0 confidence score
    source TEXT,                     -- 'observation', 'conversation', 'consolidation'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kg_subject ON knowledge_graph(chat_id, subject);
CREATE INDEX IF NOT EXISTS idx_kg_object ON knowledge_graph(chat_id, object);
CREATE INDEX IF NOT EXISTS idx_kg_predicate ON knowledge_graph(chat_id, predicate);
