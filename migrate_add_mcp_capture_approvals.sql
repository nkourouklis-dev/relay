-- Separate approval record for Copilot-created drafts.
-- Only the authenticated Relay actor who owns the draft may insert this row.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS relay_mcp_capture_approvals (
  draft_id            TEXT PRIMARY KEY REFERENCES relay_mcp_capture_drafts(id),
  approved_by_user_id TEXT NOT NULL REFERENCES relay_users(id),
  approved_at         TEXT NOT NULL
);