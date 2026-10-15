-- Restructure: 4 projects (B2B GR, B2B CY, B2C CY, B2C GR) με ADO numbers στα ονόματα.
-- Μεταφέρει τις ενέργειες/πηγές του «Kafkas.cy B2B & B2C» στο B2C CY και διαγράφει το (πλέον άδειο) project.
-- Το παλιό «B2C Greece & Cyprus» σπάει σε GR + CY (αντικαθιστά το seed_ecommerce_expansion.sql για τα B2C).
-- Τρέχει ΜΙΑ φορά, μετά το migrate_add_portfolios.sql.
UPDATE projects SET name='B2B GR - GoLive Preparation', portfolio_id='ptf-ecommerce-expansion' WHERE id='9d55a330-f488-4405-b9db-64b32c5c7b72';
UPDATE projects SET name='86064 - B2B CY - Implementation' WHERE id='prj-b2b-cyprus';

INSERT OR IGNORE INTO projects (id, name, owner_email, co_owner_email, inbox_alias, portfolio_id, created_by_user_id) VALUES
 ('prj-b2c-greece', '86069 - B2C GR - Implementation', 'smamouris@kafkas.gr', 'mrapanakis@kafkas.gr', 'b2c-greece', 'ptf-ecommerce-expansion', (SELECT id FROM relay_users WHERE lower(email) = 'nkourouklis@kafkas.gr')),
 ('prj-b2c-cyprus', '86067 - B2C CY - Implementation', 'smamouris@kafkas.gr', 'mrapanakis@kafkas.gr', 'b2c-cyprus', 'ptf-ecommerce-expansion', (SELECT id FROM relay_users WHERE lower(email) = 'nkourouklis@kafkas.gr'));

INSERT OR IGNORE INTO relay_project_members (id, project_id, email, invited_at, invite_status) VALUES
 ('pm-b2c-gr-smamouris','prj-b2c-greece','smamouris@kafkas.gr',datetime('now'),'sent'),
 ('pm-b2c-gr-mrapanakis','prj-b2c-greece','mrapanakis@kafkas.gr',datetime('now'),'sent'),
 ('pm-b2c-cy-smamouris','prj-b2c-cyprus','smamouris@kafkas.gr',datetime('now'),'sent'),
 ('pm-b2c-cy-mrapanakis','prj-b2c-cyprus','mrapanakis@kafkas.gr',datetime('now'),'sent');

INSERT OR IGNORE INTO relay_milestones (id, project_id, seq, name, tag, baseline_date, due_date) VALUES
 ('ms-b2c-gr-01', 'prj-b2c-greece', 1, 'Business Analysis Workshops Complete', 'Analysis', '2026-11-16', '2026-11-16'),
 ('ms-b2c-gr-02', 'prj-b2c-greece', 2, 'BRD Greece Drop 1 Sign-off', 'BRD', '2026-11-18', '2026-11-18'),
 ('ms-b2c-gr-03', 'prj-b2c-greece', 3, 'BRD Greece Drop 2 Sign-off', 'BRD', '2026-12-02', '2026-12-02'),
 ('ms-b2c-gr-04', 'prj-b2c-greece', 4, 'UX/UI Drop 1 Sign-off', 'Blueprint', '2027-01-11', '2027-01-11'),
 ('ms-b2c-gr-05', 'prj-b2c-greece', 5, 'UX/UI Drop 2 Sign-off', 'Blueprint', '2027-02-11', '2027-02-11'),
 ('ms-b2c-gr-06', 'prj-b2c-greece', 6, 'Technical Blueprint Greece Sign-off', 'Blueprint', '2027-01-13', '2027-01-13'),
 ('ms-b2c-gr-07', 'prj-b2c-greece', 7, 'Development Complete', 'Development', '2027-04-22', '2027-04-22'),
 ('ms-b2c-gr-08', 'prj-b2c-greece', 8, 'SIT Complete', 'SIT', '2027-04-29', '2027-04-29'),
 ('ms-b2c-gr-09', 'prj-b2c-greece', 9, 'FAT Complete', 'FAT', '2027-05-11', '2027-05-11'),
 ('ms-b2c-gr-10', 'prj-b2c-greece', 10, 'UAT Complete', 'UAT', '2027-06-15', '2027-06-15'),
 ('ms-b2c-gr-11', 'prj-b2c-greece', 11, 'Readiness Complete', 'Readiness', '2027-06-23', '2027-06-23'),
 ('ms-b2c-gr-12', 'prj-b2c-greece', 12, 'GO LIVE', 'GoLive', '2027-06-28', '2027-06-28'),
 ('ms-b2c-gr-13', 'prj-b2c-greece', 13, 'Hypercare Complete', 'Hypercare', '2027-07-12', '2027-07-12'),
 ('ms-b2c-cy-01', 'prj-b2c-cyprus', 1, 'Business Analysis Workshops Complete', 'Analysis', '2026-11-16', '2026-11-16'),
 ('ms-b2c-cy-02', 'prj-b2c-cyprus', 2, 'BRD Cyprus Drop 1 Sign-off', 'BRD', '2026-12-18', '2026-12-18'),
 ('ms-b2c-cy-03', 'prj-b2c-cyprus', 3, 'BRD Cyprus Drop 2 Sign-off', 'BRD', '2027-01-13', '2027-01-13'),
 ('ms-b2c-cy-04', 'prj-b2c-cyprus', 4, 'UX/UI Drop 1 Sign-off', 'Blueprint', '2027-01-11', '2027-01-11'),
 ('ms-b2c-cy-05', 'prj-b2c-cyprus', 5, 'UX/UI Drop 2 Sign-off', 'Blueprint', '2027-02-11', '2027-02-11'),
 ('ms-b2c-cy-06', 'prj-b2c-cyprus', 6, 'Technical Blueprint Cyprus Sign-off', 'Blueprint', '2027-02-02', '2027-02-02'),
 ('ms-b2c-cy-07', 'prj-b2c-cyprus', 7, 'Development Complete', 'Development', '2027-04-22', '2027-04-22'),
 ('ms-b2c-cy-08', 'prj-b2c-cyprus', 8, 'SIT Complete', 'SIT', '2027-04-29', '2027-04-29'),
 ('ms-b2c-cy-09', 'prj-b2c-cyprus', 9, 'FAT Complete', 'FAT', '2027-05-11', '2027-05-11'),
 ('ms-b2c-cy-10', 'prj-b2c-cyprus', 10, 'UAT Complete', 'UAT', '2027-06-15', '2027-06-15'),
 ('ms-b2c-cy-11', 'prj-b2c-cyprus', 11, 'Readiness Complete', 'Readiness', '2027-06-23', '2027-06-23'),
 ('ms-b2c-cy-12', 'prj-b2c-cyprus', 12, 'GO LIVE', 'GoLive', '2027-06-28', '2027-06-28'),
 ('ms-b2c-cy-13', 'prj-b2c-cyprus', 13, 'Hypercare Complete', 'Hypercare', '2027-07-12', '2027-07-12');

-- Κυπριακό backlog: από «Kafkas.cy B2B & B2C» -> B2C CY
UPDATE asks    SET project_id='prj-b2c-cyprus' WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d';
UPDATE sources SET project_id='prj-b2c-cyprus' WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d';
UPDATE relay_board_columns SET project_id='prj-b2c-cyprus' WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d';
DELETE FROM projects WHERE id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d'
  AND NOT EXISTS (SELECT 1 FROM asks WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d')
  AND NOT EXISTS (SELECT 1 FROM sources WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d')
  AND NOT EXISTS (SELECT 1 FROM relay_board_columns WHERE project_id='5b6e3c8c-fed3-4b24-9dae-022c94ddbb8d');

-- Παλιό ενιαίο «B2C Greece & Cyprus» (0 asks) -> αντικαταστάθηκε από GR + CY
DELETE FROM relay_milestones WHERE project_id='prj-b2c-greece-cyprus';
DELETE FROM relay_project_members WHERE project_id='prj-b2c-greece-cyprus';
DELETE FROM projects WHERE id='prj-b2c-greece-cyprus'
  AND NOT EXISTS (SELECT 1 FROM asks WHERE project_id='prj-b2c-greece-cyprus');
