-- Link Relay users to immutable Microsoft Entra tenant/object identifiers.
-- The email is used only for the first allowed account match; later requests use tenant_id + object_id.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS relay_entra_identities (
  tenant_id    TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL UNIQUE REFERENCES relay_users(id) ON DELETE CASCADE,
  linked_email TEXT NOT NULL,
  linked_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object_id)
);