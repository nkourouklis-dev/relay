-- Backfill: συνδέει υπάρχοντα asks με λογαριασμό, όπου το legacy created_by (email)
-- ταιριάζει ακριβώς με email υπάρχοντος χρήστη. Τα υπόλοιπα μένουν NULL (ορατά μόνο σε admin).
-- Ασφαλές να ξανατρέξει (π.χ. αφού κάνει login για πρώτη φορά κάποιος με legacy asks).
--   npx wrangler d1 execute relay-db --remote --file=./migrate_phase1_backfill_created_by.sql
UPDATE asks
SET created_by_user_id = (
  SELECT id FROM relay_users WHERE lower(relay_users.email) = lower(trim(asks.created_by))
)
WHERE created_by_user_id IS NULL
  AND trim(COALESCE(created_by, '')) != '';
