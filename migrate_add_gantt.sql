-- Additive migration: Gantt items ανά project (bars = φάσεις, flags = gates/releases, bands = π.χ. holiday freeze).
-- Safe to re-run.
--   npx wrangler d1 execute relay-db --local  --file=./migrate_add_gantt.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_gantt.sql
CREATE TABLE IF NOT EXISTS relay_gantt_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,        -- bar | flag | band
  label       TEXT NOT NULL,
  style       TEXT,                 -- workshops|tech_workshops|analysis_brd|brd_gr|brd_cy|uxui|blueprint|development|sit|fat_uat|hypercare|phase_b|gate|golive|freeze
  start_date  TEXT NOT NULL,        -- YYYY-MM-DD (flag: η ημερομηνία)
  end_date    TEXT,                 -- YYYY-MM-DD (flag: NULL)
  note        TEXT,
  milestone_id TEXT REFERENCES relay_milestones(id),
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_gantt_project ON relay_gantt_items(project_id, start_date);
