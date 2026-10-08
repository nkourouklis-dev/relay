-- Additive migration: story points (Fibonacci) και link προς Azure DevOps work item ανά ask.
-- Δεν αγγίζει υπάρχοντα δεδομένα. Τρέχει ΜΙΑ φορά ανά βάση (το ALTER TABLE ADD COLUMN
-- του SQLite αποτυγχάνει αν η στήλη υπάρχει ήδη).
--   npx wrangler d1 execute relay-db --remote --file=./migrate_add_story_points_ado.sql

ALTER TABLE asks ADD COLUMN story_points INTEGER;  -- 1 | 2 | 3 | 5 | 8 | 13 | 21, NULL = χωρίς εκτίμηση
ALTER TABLE asks ADD COLUMN ado_url TEXT;          -- https link προς το Azure DevOps work item
