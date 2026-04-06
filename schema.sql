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
