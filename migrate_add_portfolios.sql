-- Additive migration: portfolios + milestones (Portfolio -> Project -> Milestone -> Ask).
-- Δεν αγγίζει υπάρχοντα δεδομένα. Τρέχει ΜΙΑ φορά ανά βάση (ALTER TABLE ADD COLUMN δεν είναι idempotent).
--   npx wrangler d1 execute relay-db --local  --file=./migrate_add_portfolios.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_portfolios.sql

CREATE TABLE IF NOT EXISTS relay_portfolios (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  owner_email          TEXT NOT NULL,            -- lowercase
  report_weekday       INTEGER NOT NULL DEFAULT 5,  -- 1=Δευ ... 5=Παρ (weekly status)
  red_slip_business_days INTEGER NOT NULL DEFAULT 3, -- RED όταν milestone γλιστρήσει > N εργάσιμες
  created_by_user_id   TEXT REFERENCES relay_users(id),
  created_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relay_portfolio_members (
  portfolio_id TEXT NOT NULL REFERENCES relay_portfolios(id),
  email        TEXT NOT NULL,                    -- lowercase
  role         TEXT NOT NULL DEFAULT 'member',   -- owner | member
  PRIMARY KEY (portfolio_id, email)
);

CREATE TABLE IF NOT EXISTS relay_milestones (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  seq           INTEGER NOT NULL,                -- σειρά εμφάνισης μέσα στο project
  name          TEXT NOT NULL,
  tag           TEXT NOT NULL,                   -- Analysis|BRD|Blueprint|Development|SIT|FAT|UAT|Readiness|Hypercare|GoLive
  baseline_date TEXT NOT NULL,                   -- αρχικό due (YYYY-MM-DD), για υπολογισμό slip
  due_date      TEXT NOT NULL,                   -- τρέχον due (YYYY-MM-DD)
  status        TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | done
  completed_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON relay_milestones(project_id, due_date);

ALTER TABLE projects ADD COLUMN portfolio_id TEXT REFERENCES relay_portfolios(id);
ALTER TABLE projects ADD COLUMN co_owner_email TEXT;
ALTER TABLE asks ADD COLUMN milestone_id TEXT REFERENCES relay_milestones(id);
CREATE INDEX IF NOT EXISTS idx_projects_portfolio ON projects(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_asks_milestone ON asks(milestone_id);

-- asks.kind: προστίθεται η τιμή 'rfi' (action|decision|commitment|risk|blocker|rfi) — χωρίς αλλαγή schema (free text).
-- Το "κάθε ask ανήκει σε milestone" θα επιβληθεί στο API για projects με portfolio_id (Phase 2),
-- ΟΧΙ με trigger, ώστε email handler και /api/ingest να μη σπάσουν.
