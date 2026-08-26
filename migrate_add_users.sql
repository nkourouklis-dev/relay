-- Migration: Phase A — Add users table and link asks to users via owner_user_id
-- Τρέξε αυτό ΜΙΑ ΦΟΡΑ, και στο local ΚΑΙ στο remote (production).
-- ALTER TABLE ADD COLUMN will error if run twice, so apply only once per environment.

-- Create users table (Better Auth will manage its own session/token tables separately)
-- NOTE: user id is currently set to email address for phase A. Phase B may need to reconcile 
-- this with Better Auth's own user ID scheme — do not forget to review this during auth wiring.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Add the foreign key column to asks (linking existing owners to user records)
ALTER TABLE asks ADD COLUMN owner_user_id TEXT REFERENCES users(id);

-- Backfill: auto-create users for all distinct valid email addresses already in asks.owner
-- Email pattern: contains @ and a dot after the @
INSERT OR IGNORE INTO users (id, email, created_at)
SELECT 
  lower(owner) AS id,
  lower(owner) AS email,
  datetime('now')
FROM (
  SELECT DISTINCT owner FROM asks WHERE owner IS NOT NULL AND owner != ''
)
WHERE owner LIKE '%@%.%'
  AND NOT EXISTS (SELECT 1 FROM users WHERE email = lower(owner));

-- Link asks to the newly created user records (for valid email owners only)
UPDATE asks
SET owner_user_id = (SELECT id FROM users WHERE email = lower(asks.owner))
WHERE owner IS NOT NULL 
  AND owner != ''
  AND owner LIKE '%@%.%'
  AND owner_user_id IS NULL;