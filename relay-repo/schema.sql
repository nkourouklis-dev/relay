-- Relay MVP schema (D1 / SQLite)
-- Τρέξε: wrangler d1 execute relay-db --file=./schema.sql --local   (τοπικά)
--        wrangler d1 execute relay-db --file=./schema.sql --remote  (production)

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS asks;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS projects;

-- Έργα (outcomes rollup)
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_email  TEXT,
  inbox_alias  TEXT UNIQUE,           -- π.χ. "acme" -> acme@in.relay.app
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Πηγές: κάθε email/chat/note/file που μπήκε
CREATE TABLE sources (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  type         TEXT NOT NULL,          -- email | chat | mom | note | file
  sender       TEXT,
  subject      TEXT,
  body         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Asks: η ατομική μονάδα δουλειάς (from -> to, result, by-when, status)
CREATE TABLE asks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  source_id     TEXT REFERENCES sources(id),
  kind          TEXT DEFAULT 'action', -- action | decision | commitment | risk | blocker
  title         TEXT NOT NULL,
  owner         TEXT,                  -- ποιος το χρωστάει
  requested_by  TEXT,
  due_date      TEXT,                  -- YYYY-MM-DD
  status        TEXT DEFAULT 'open',   -- open | accepted | done | overdue
  confidence    REAL DEFAULT 1.0,
  source_quote  TEXT,                  -- το ακριβές απόσπασμα (trust)
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Timeline γεγονότων ανά ask (created/restated/slipped/completed)
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  ask_id      TEXT NOT NULL REFERENCES asks(id),
  type        TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_asks_project ON asks(project_id);
CREATE INDEX idx_asks_status  ON asks(status);
CREATE INDEX idx_sources_proj ON sources(project_id);

-- Demo δεδομένα για να δεις κάτι αμέσως
INSERT INTO projects (id, name, owner_email, inbox_alias)
VALUES ('demo', 'Demo Project', 'you@example.com', 'demo');

INSERT INTO asks (id, project_id, title, owner, requested_by, due_date, status, source_quote)
VALUES
 ('a1','demo','Στείλε το updated BRD','vendor@acme.com','you@example.com','2026-08-20','overdue','...can you send the updated BRD by Wed?'),
 ('a2','demo','Επιβεβαίωσε την ημερομηνία UAT','pm@internal.com','you@example.com','2026-08-30','accepted','let''s lock UAT for the 30th'),
 ('a3','demo','Απόφαση: πάμε με το MVP scope','you@example.com','steering','2026-08-25','open','we agreed to ship the MVP first');
