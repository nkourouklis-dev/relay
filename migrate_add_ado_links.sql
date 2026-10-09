-- Additive migration: σύνδεση project του Relay με Azure DevOps (read-only, src/ado.js).
-- Δεν αγγίζει υπάρχοντα δεδομένα. Idempotent (μόνο CREATE ... IF NOT EXISTS).
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_ado_links.sql
-- Το token ΔΕΝ μπαίνει εδώ: είναι Cloudflare secret (npx wrangler secret put ADO_PAT).

-- Ποιο ADO org/project (και προαιρετικά shared query) αντιστοιχεί σε κάθε project. Το ορίζει μόνο admin.
CREATE TABLE IF NOT EXISTS relay_ado_links (
  project_id          TEXT PRIMARY KEY REFERENCES projects(id),
  org                 TEXT NOT NULL,
  ado_project         TEXT NOT NULL,
  query_id            TEXT,                 -- GUID shared query· αν υπάρχει, υπερισχύει των φίλτρων
  work_item_types     TEXT NOT NULL DEFAULT 'Bug',
  exclude_states      TEXT NOT NULL DEFAULT 'Closed,Done,Removed',
  updated_by_user_id  TEXT REFERENCES relay_users(id),
  updated_at          TEXT NOT NULL
);

-- Τελευταία επιτυχημένη λήψη ανά project (cache λίγων λεπτών + «τελευταία γνωστά» όταν το ADO δεν απαντά).
CREATE TABLE IF NOT EXISTS relay_ado_cache (
  project_id    TEXT PRIMARY KEY REFERENCES projects(id),
  payload_json  TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);
