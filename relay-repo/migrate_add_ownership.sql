-- Migration: προσθέτει τη στήλη "created_by" στα asks, ΧΩΡΙΣ να σβήσει υπάρχοντα δεδομένα.
-- Τρέξε αυτό ΜΙΑ ΦΟΡΑ, και στο local ΚΑΙ στο remote (production).
ALTER TABLE asks ADD COLUMN created_by TEXT DEFAULT '';
