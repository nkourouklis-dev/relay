-- Relay MVP schema (D1 / SQLite)
-- Τρέξε: wrangler d1 execute relay-db --file=./schema.sql --local   (τοπικά)
--        wrangler d1 execute relay-db --file=./schema.sql --remote  (production)

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS asks;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS users;

-- Χρήστες: κάθε χρήστης αναγνωρίζεται από το email του
-- NOTE: Phase A sets id = email. Phase B (Better Auth) may use its own user ID scheme;
-- reconcile this during auth wiring to avoid duplicate identity records.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Better Auth 1.7.1 core tables. Dates are ISO-8601 strings, as stored by
-- the D1/Kysely adapter. See migrate_add_better_auth_core.sql for the source.
CREATE TABLE relay_users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE TABLE relay_sessions (
  id        TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId    TEXT NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE
);

CREATE TABLE relay_accounts (
  id                    TEXT PRIMARY KEY,
  issuer                TEXT NOT NULL,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                TEXT NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  password              TEXT,
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL,
  UNIQUE (issuer, accountId)
);

CREATE TABLE relay_verifications (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

CREATE INDEX relay_sessions_userId_idx ON relay_sessions(userId);
CREATE INDEX relay_accounts_userId_idx ON relay_accounts(userId);
CREATE INDEX relay_verifications_identifier_idx ON relay_verifications(identifier);

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
  owner         TEXT,                  -- ποιος το χρωστάει (free text, legacy fallback)
  owner_user_id TEXT REFERENCES users(id),  -- link to users table (preferred identity)
  requested_by  TEXT,
  due_date      TEXT,                  -- YYYY-MM-DD
  status        TEXT DEFAULT 'open',   -- open | accepted | done | overdue
  confidence    REAL DEFAULT 1.0,
  source_quote  TEXT,                  -- το ακριβές απόσπασμα (trust)
  created_by    TEXT DEFAULT '',
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
CREATE INDEX idx_asks_owner_user ON asks(owner_user_id);
CREATE INDEX idx_sources_proj ON sources(project_id);

-- Demo δεδομένα για να δεις κάτι αμέσως
INSERT INTO projects (id, name, owner_email, inbox_alias)
VALUES ('demo', 'Demo Project', 'you@example.com', 'demo');

-- Create demo users
INSERT INTO users (id, email, name, created_at)
VALUES 
  ('you@example.com', 'you@example.com', 'You', datetime('now')),
  ('vendor@acme.com', 'vendor@acme.com', 'Vendor', datetime('now')),
  ('pm@internal.com', 'pm@internal.com', 'PM', datetime('now'));

INSERT INTO asks (id, project_id, title, owner, owner_user_id, requested_by, due_date, status, source_quote)
VALUES
  ('a1','demo','Στείλε το updated BRD','vendor@acme.com','vendor@acme.com','you@example.com','2026-08-20','overdue','...can you send the updated BRD by Wed?'),
  ('a2','demo','Επιβεβαίωσε την ημερομηνία UAT','pm@internal.com','pm@internal.com','you@example.com','2026-08-30','accepted','let''s lock UAT for the 30th'),
  ('a3','demo','Απόφαση: πάμε με το MVP scope','you@example.com','you@example.com','steering','2026-08-25','open','we agreed to ship the MVP first');