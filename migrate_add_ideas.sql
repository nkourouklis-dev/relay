-- Additive migration: team ideas (ported from the retired iBOX prototype),
-- scoped internally per Relay project/team, plus per-idea audit trail and
-- server-side (per-user) gamification. Safe to run twice; no DROP, no
-- changes to existing tables.
-- Run: wrangler d1 execute relay-db --file=./migrate_add_ideas.sql --local
--      wrangler d1 execute relay-db --file=./migrate_add_ideas.sql --remote

CREATE TABLE IF NOT EXISTS relay_ideas (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  title              TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'Γενική πρόταση',
  problem            TEXT NOT NULL DEFAULT '',
  proposed_solution  TEXT NOT NULL DEFAULT '',
  expected_benefit   TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'Υποβλήθηκε',
  owner_user_id      TEXT NOT NULL REFERENCES relay_users(id),
  created_by_user_id TEXT NOT NULL REFERENCES relay_users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON relay_ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_owner ON relay_ideas(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON relay_ideas(status);

-- Per-idea activity/audit trail — real actor identity (relay_users.id),
-- never a service account, same discipline as the iBOX AuditLog design.
CREATE TABLE IF NOT EXISTS relay_idea_events (
  id            TEXT PRIMARY KEY,
  idea_id       TEXT NOT NULL REFERENCES relay_ideas(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES relay_users(id),
  type          TEXT NOT NULL,   -- created | status_changed
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_idea_events_idea ON relay_idea_events(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_events_actor ON relay_idea_events(actor_user_id);

-- Gamification, one row per real user — server-side (D1), not per-browser
-- localStorage, since this is a real multi-user product, not a local demo.
CREATE TABLE IF NOT EXISTS relay_gamification (
  user_id     TEXT PRIMARY KEY REFERENCES relay_users(id) ON DELETE CASCADE,
  xp          INTEGER NOT NULL DEFAULT 0,
  badges_json TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
