-- Migration: μέλη ομάδας ανά project (πρόσκληση με email).
-- Ένα email που είναι μέλος project μπορεί να κάνει login ακόμα κι αν δεν είναι @kafkas.gr
-- (π.χ. συνεργάτης Netcompany) — τέτοια μέλη προσθέτει μόνο admin.
-- Ασφαλές να ξανατρέξει.
--   npx wrangler d1 execute relay-db --local  --file=./migrate_project_members.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_project_members.sql
CREATE TABLE IF NOT EXISTS relay_project_members (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  email              TEXT NOT NULL,                 -- πάντα lowercase
  invited_by_user_id TEXT REFERENCES relay_users(id),
  invited_at         TEXT NOT NULL,
  invite_status      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  UNIQUE (project_id, email)
);

CREATE INDEX IF NOT EXISTS idx_project_members_email ON relay_project_members(email);
