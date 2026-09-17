-- Migration: browsers που έχουν επιβεβαιωθεί με κωδικό email ("trusted devices").
-- Σε αυτούς ο χρήστης ξαναμπαίνει μόνο με το email του, χωρίς νέο κωδικό.
-- Αποθηκεύεται μόνο το SHA-256 του token (το token είναι σε HttpOnly cookie).
-- Ασφαλές να ξανατρέξει (IF NOT EXISTS).
--   npx wrangler d1 execute relay-db --local  --file=./migrate_trusted_devices.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_trusted_devices.sql
-- Ανάκληση όλων των browsers ενός χρήστη:
--   DELETE FROM relay_trusted_devices WHERE user_id = (SELECT id FROM relay_users WHERE lower(email) = lower('...'));
CREATE TABLE IF NOT EXISTS relay_trusted_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON relay_trusted_devices(user_id);
