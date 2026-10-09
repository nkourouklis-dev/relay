-- Additive migration: προσωπικό πρωινό email «Τα δικά σου σήμερα» (src/daily-digest.js).
-- Δεν αγγίζει υπάρχοντα δεδομένα. Idempotent (μόνο CREATE ... IF NOT EXISTS).
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_daily_digest.sql

-- Ένα email ανά άνθρωπο ανά ημέρα (ώρα Αθήνας). Η γραμμή «κλειδώνει» την αποστολή.
CREATE TABLE IF NOT EXISTS relay_daily_digests (
  email        TEXT NOT NULL,
  digest_date  TEXT NOT NULL,             -- YYYY-MM-DD (Europe/Athens)
  sent_at      TEXT NOT NULL,
  item_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, digest_date)
);

-- Προτιμήσεις email ανά διεύθυνση (απουσία γραμμής = ενεργό).
CREATE TABLE IF NOT EXISTS relay_email_prefs (
  email         TEXT PRIMARY KEY,
  daily_digest  INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL
);
