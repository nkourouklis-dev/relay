-- Additive migration: κεντρικές Ιδέες (όχι πια ανά project).
-- Οι ιδέες χρειάζονται project_id (NOT NULL + FK), οπότε αντί για rebuild του πίνακα προσθέτουμε ένα
-- κρυφό «σπίτι» για τις γενικές ιδέες. Δεν εμφανίζεται σε λίστες projects· οι ιδέες που αφορούν
-- συγκεκριμένο project κρατούν το project_id του ως ετικέτα. Idempotent.
--   npx wrangler d1 execute relay-db --remote --file=./migrate_central_ideas.sql

INSERT OR IGNORE INTO projects (id, name, inbox_alias, created_by_user_id)
VALUES ('relay-ideas-hub', 'Κεντρικές ιδέες', NULL, NULL);
