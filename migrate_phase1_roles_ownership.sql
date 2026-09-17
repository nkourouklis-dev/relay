-- Migration: Φάση 1 — ρόλοι χρηστών + created_by δεμένο σε πραγματικό λογαριασμό.
-- Τρέξε αυτό ΜΙΑ ΦΟΡΑ, πρώτα local και μετά remote (production), ΠΡΙΝ το deploy του νέου κώδικα.
-- ALTER TABLE ADD COLUMN αποτυγχάνει αν τρέξει δεύτερη φορά.
--   npx wrangler d1 execute relay-db --local  --file=./migrate_phase1_roles_ownership.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_phase1_roles_ownership.sql

-- Ρόλος χρήστη (Better Auth user table). SQLite δεν έχει enum -> CHECK constraint.
ALTER TABLE relay_users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'));

-- Δημιουργός ως πραγματικό user id. NULL = legacy/ορφανό -> ορατό μόνο σε admin.
ALTER TABLE projects ADD COLUMN created_by_user_id TEXT REFERENCES relay_users(id);
ALTER TABLE asks ADD COLUMN created_by_user_id TEXT REFERENCES relay_users(id);

CREATE INDEX IF NOT EXISTS idx_projects_created_by_user ON projects(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_asks_created_by_user ON asks(created_by_user_id);

-- Τα υπάρχοντα projects δεν έχουν καμία πληροφορία δημιουργού -> μένουν NULL (μόνο admin).
-- Το backfill των asks γίνεται στο migrate_phase1_backfill_created_by.sql (ασφαλές να ξανατρέξει).
