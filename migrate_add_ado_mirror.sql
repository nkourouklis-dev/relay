-- Additive migration: αυτόματος καθρέφτης ADO → Ενέργειες (src/ado.js, ADO Φάση 2).
-- Δεν αγγίζει υπάρχοντα δεδομένα. Τρέχει ΜΙΑ φορά ανά βάση (ALTER TABLE ADD COLUMN δεν είναι idempotent).
-- Προϋπόθεση: migrate_add_ado_links.sql.
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_ado_mirror.sql

ALTER TABLE relay_ado_links ADD COLUMN area_path TEXT;                          -- WIQL: [System.AreaPath] UNDER
ALTER TABLE relay_ado_links ADD COLUMN auto_mirror INTEGER NOT NULL DEFAULT 1;  -- 1 = το ADO είναι η αλήθεια
ALTER TABLE relay_ado_links ADD COLUMN last_mirror_at TEXT;
ALTER TABLE relay_ado_links ADD COLUMN last_mirror_error TEXT;
ALTER TABLE relay_ado_links ADD COLUMN last_mirror_count INTEGER;

-- Κατάσταση κάθε καθρεφτισμένου work item (ό,τι δεν χωράει στα πεδία του ask).
CREATE TABLE IF NOT EXISTS relay_ado_items (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  work_item_id    TEXT NOT NULL,
  ask_id          TEXT REFERENCES asks(id),
  work_item_type  TEXT,
  state           TEXT,
  severity        TEXT,
  assigned_name   TEXT,
  assigned_email  TEXT,
  area_path       TEXT,
  iteration_path  TEXT,
  tags            TEXT,
  changed_at      TEXT,
  last_seen_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_ado_items_ask ON relay_ado_items(ask_id);
