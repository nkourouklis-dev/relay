-- Additive migration: accountable (υπεύθυνος/accountable άτομο) ανά project, ελεύθερο κείμενο (όνομα).
-- ΔΕΝ γίνεται auto-map σε email. Τρέχει ΜΙΑ φορά (ALTER TABLE ADD COLUMN δεν είναι idempotent).
--   npx wrangler d1 execute relay-db --local  --file=./migrate_add_project_accountable.sql
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_project_accountable.sql
ALTER TABLE projects ADD COLUMN accountable TEXT;

UPDATE projects SET accountable = 'Βαγγέλης' WHERE id = 'prj-b2b-cyprus';
