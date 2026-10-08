-- Additive migration: sprints ανά project + σύνδεση ask -> sprint (NULL = backlog).
-- Δεν αγγίζει υπάρχοντα δεδομένα. Τρέχει ΜΙΑ φορά ανά βάση (ALTER TABLE ADD COLUMN δεν είναι idempotent).
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_sprints.sql

CREATE TABLE IF NOT EXISTS relay_sprints (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  goal        TEXT,
  start_date  TEXT,                              -- YYYY-MM-DD
  end_date    TEXT,                              -- YYYY-MM-DD
  status      TEXT NOT NULL DEFAULT 'planned',   -- planned | active | closed
  created_by_user_id TEXT REFERENCES relay_users(id),
  created_at  TEXT DEFAULT (datetime('now')),
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON relay_sprints(project_id, status);

ALTER TABLE asks ADD COLUMN sprint_id TEXT REFERENCES relay_sprints(id);
CREATE INDEX IF NOT EXISTS idx_asks_sprint ON asks(sprint_id);
