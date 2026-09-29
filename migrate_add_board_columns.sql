-- Additive migration: πίνακας στηλών για το Board view (Step 5 του UI redesign).
-- Γενικό board, διαθέσιμο σε κάθε project — όχι ρύθμιση ανά συγκεκριμένο project.
-- Ομαδοποίηση drag-and-drop είτε ανά section (φάση) είτε ανά assignee (owner).
-- Δεν αγγίζει ούτε το asks ούτε κανένα υπάρχον table.

CREATE TABLE IF NOT EXISTS relay_board_columns (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  group_by     TEXT NOT NULL CHECK (group_by IN ('section', 'assignee')),
  column_key   TEXT NOT NULL,   -- η τιμή που γράφεται στο asks.section ή asks.owner όταν μια κάρτα πέφτει εδώ
  label        TEXT NOT NULL,   -- ο τίτλος της στήλης, όπως φαίνεται στο UI (μπορεί να μετονομαστεί)
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_board_columns_project ON relay_board_columns(project_id, group_by, sort_order);
