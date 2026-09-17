-- Migration: πεδία Master Task List import, dependencies και reminders.
-- Additive μόνο. Τα ALTER TABLE αποτυγχάνουν αν τρέξουν δεύτερη φορά (τρέξε ΜΙΑ φορά ανά περιβάλλον).
--   npx wrangler d1 execute relay-db --local  --file=./migrate_master_task_import.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_master_task_import.sql

-- Asks: νέα πεδία (όλα προαιρετικά, τα υπάρχοντα asks δεν επηρεάζονται)
ALTER TABLE asks ADD COLUMN priority TEXT;             -- critical | high | medium | low
ALTER TABLE asks ADD COLUMN source_status TEXT;        -- αρχικό status της πηγής (π.χ. "Pending ETA")
ALTER TABLE asks ADD COLUMN section TEXT;              -- GROUP της πηγής
ALTER TABLE asks ADD COLUMN start_date TEXT;           -- YYYY-MM-DD
ALTER TABLE asks ADD COLUMN due_constraint TEXT;       -- λεκτική προθεσμία (π.χ. "Before Go-Live")
ALTER TABLE asks ADD COLUMN go_live_blocking TEXT;     -- yes | potential | no
ALTER TABLE asks ADD COLUMN assignees TEXT;            -- ονόματα/ομάδες, comma-separated
ALTER TABLE asks ADD COLUMN accountable TEXT;
ALTER TABLE asks ADD COLUMN external_import_key TEXT;  -- σταθερό κλειδί idempotent import
ALTER TABLE asks ADD COLUMN import_batch_id TEXT;
ALTER TABLE asks ADD COLUMN details_json TEXT;         -- acceptance criteria, notes, reference, reminder policy κ.λπ.
ALTER TABLE asks ADD COLUMN import_snapshot_json TEXT; -- τελευταίες εισαγμένες τιμές (για merge χωρίς απώλεια user edits)

CREATE UNIQUE INDEX IF NOT EXISTS idx_asks_import_key
  ON asks(project_id, external_import_key) WHERE external_import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS relay_ask_dependencies (
  id                TEXT PRIMARY KEY,
  ask_id            TEXT NOT NULL REFERENCES asks(id),
  depends_on_ask_id TEXT NOT NULL REFERENCES asks(id),
  source            TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (ask_id, depends_on_ask_id)
);

CREATE TABLE IF NOT EXISTS relay_reminders (
  id           TEXT PRIMARY KEY,
  ask_id       TEXT NOT NULL REFERENCES asks(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  remind_at    TEXT NOT NULL,          -- UTC ISO
  rule         TEXT NOT NULL,
  recurrence   TEXT,                   -- NULL = μία φορά
  dedupe_key   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sent | cancelled
  last_sent_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON relay_reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_ask_dependencies_depends_on ON relay_ask_dependencies(depends_on_ask_id);
