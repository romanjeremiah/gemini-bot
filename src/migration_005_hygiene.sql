-- ==========================================
-- Migration 005: Production hygiene
-- ==========================================
--
-- 1. Index on training_pairs(signal, persona) for fast LoRA-extract queries
--    where you slice the dataset by persona + reaction type. The existing
--    idx_training_pairs_user_signal still serves per-user lookups.
--
-- 2. updated_at AFTER UPDATE triggers on tables whose JS code does NOT
--    explicitly bump updated_at on every UPDATE. SQLite does not auto-update
--    DATETIME columns; the DEFAULT CURRENT_TIMESTAMP only applies on INSERT.
--    Without these triggers, updated_at silently stays at the row's creation
--    time after every UPDATE.
--
--    The `WHEN OLD.updated_at IS NEW.updated_at` guard makes triggers
--    idempotent: if application code explicitly sets updated_at, the trigger
--    skips (because OLD != NEW). When the trigger itself does the second
--    UPDATE to set updated_at, the recursive trigger fires with OLD != NEW
--    and skips, avoiding the infinite-loop risk you get without
--    recursive_triggers=OFF.
--
-- Run remotely:
--   npx wrangler d1 execute reminders_db --remote --file=src/migration_005_hygiene.sql
--

-- ---- 1. training_pairs(signal, persona) index ----
CREATE INDEX IF NOT EXISTS idx_training_pairs_signal_persona
    ON training_pairs(signal, persona);

-- ---- 2. updated_at triggers ----

-- user_profiles (PK: user_id)
DROP TRIGGER IF EXISTS trg_user_profiles_updated_at;
CREATE TRIGGER trg_user_profiles_updated_at
    AFTER UPDATE ON user_profiles
    FOR EACH ROW
    WHEN OLD.updated_at IS NEW.updated_at
BEGIN
    UPDATE user_profiles
       SET updated_at = CURRENT_TIMESTAMP
     WHERE user_id = NEW.user_id;
END;

-- persona_config (composite PK: user_id, persona_key)
DROP TRIGGER IF EXISTS trg_persona_config_updated_at;
CREATE TRIGGER trg_persona_config_updated_at
    AFTER UPDATE ON persona_config
    FOR EACH ROW
    WHEN OLD.updated_at IS NEW.updated_at
BEGIN
    UPDATE persona_config
       SET updated_at = CURRENT_TIMESTAMP
     WHERE user_id = NEW.user_id AND persona_key = NEW.persona_key;
END;

-- reminders (PK: id)
DROP TRIGGER IF EXISTS trg_reminders_updated_at;
CREATE TRIGGER trg_reminders_updated_at
    AFTER UPDATE ON reminders
    FOR EACH ROW
    WHEN OLD.updated_at IS NEW.updated_at
BEGIN
    UPDATE reminders
       SET updated_at = CURRENT_TIMESTAMP
     WHERE id = NEW.id;
END;

-- mood_journal (PK: id)
DROP TRIGGER IF EXISTS trg_mood_journal_updated_at;
CREATE TRIGGER trg_mood_journal_updated_at
    AFTER UPDATE ON mood_journal
    FOR EACH ROW
    WHEN OLD.updated_at IS NEW.updated_at
BEGIN
    UPDATE mood_journal
       SET updated_at = CURRENT_TIMESTAMP
     WHERE id = NEW.id;
END;
