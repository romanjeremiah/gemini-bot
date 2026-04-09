-- Mood Journal table for daily mental health tracking
CREATE TABLE IF NOT EXISTS mood_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'evening',
  mood_score INTEGER,
  mood_label TEXT,
  emotions TEXT,
  sleep_hours REAL,
  sleep_quality TEXT,
  medication_taken INTEGER DEFAULT 0,
  medication_time TEXT,
  medication_notes TEXT,
  activities TEXT,
  note TEXT,
  photo_r2_key TEXT,
  ai_observation TEXT,
  context_summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mood_journal_chat_date ON mood_journal(chat_id, date);
CREATE INDEX IF NOT EXISTS idx_mood_journal_chat_type ON mood_journal(chat_id, entry_type);
