-- Add short-lived, project-scoped Copilot capture drafts.
-- The source transcript is never stored in this table; only extracted asks and quotes are retained.
-- Safe to run more than once.
--   npx wrangler d1 execute relay-db --local  --file=./migrate_add_mcp_capture_drafts.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_mcp_capture_drafts.sql
CREATE TABLE IF NOT EXISTS relay_mcp_capture_drafts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  actor_user_id TEXT NOT NULL REFERENCES relay_users(id),
  source_title  TEXT,
  source_url    TEXT,
  items_json    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committing', 'committed')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  committed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_capture_drafts_actor ON relay_mcp_capture_drafts(actor_user_id, status);
CREATE INDEX IF NOT EXISTS idx_mcp_capture_drafts_expiry ON relay_mcp_capture_drafts(expires_at);