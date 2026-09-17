-- Bootstrap admin: τρέχει χειροκίνητα, ΑΦΟΥ ο χρήστης έχει κάνει login μία φορά
-- (ώστε να υπάρχει η εγγραφή στο relay_users). Άλλαξε το email πριν το τρέξεις.
--   npx wrangler d1 execute relay-db --remote --file=./bootstrap_admin.sql
-- Έλεγχος:
--   npx wrangler d1 execute relay-db --remote --command="SELECT email, role FROM relay_users"
UPDATE relay_users SET role = 'admin' WHERE lower(email) = lower('CHANGE_ME@example.com');
