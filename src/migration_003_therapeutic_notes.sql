-- MIGRATION: therapeutic_notes table
-- Run with: npx wrangler d1 execute YOUR_DB_NAME --file=./migrations/003_therapeutic_notes.sql
-- Or run each statement via Cloudflare dashboard D1 console

CREATE TABLE IF NOT EXISTS therapeutic_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    note_type TEXT NOT NULL CHECK(note_type IN ('pattern', 'schema', 'avoidance', 'homework', 'session', 'trigger', 'growth')),
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_therapeutic_chat_id ON therapeutic_notes(chat_id);
CREATE INDEX IF NOT EXISTS idx_therapeutic_type ON therapeutic_notes(chat_id, note_type);
CREATE INDEX IF NOT EXISTS idx_therapeutic_created ON therapeutic_notes(chat_id, created_at DESC);
