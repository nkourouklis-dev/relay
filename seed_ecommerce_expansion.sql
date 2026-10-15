-- SUPERSEDED για τα B2C από restructure_ecommerce_projects.sql — μην ξανατρέξεις αυτό το seed.
-- Seed: eCommerce Expansion Programme (2 projects, 29 milestones). Σταθερά IDs, ασφαλές να ξανατρέξει.
-- Προαπαιτεί migrate_add_portfolios.sql. Δεν δημιουργεί asks.
--   npx wrangler d1 execute relay-db --local  --file=./seed_ecommerce_expansion.sql
--   npx wrangler d1 execute relay-db --remote --file=./seed_ecommerce_expansion.sql

INSERT OR IGNORE INTO relay_portfolios (id, name, owner_email, created_by_user_id)
VALUES ('ptf-ecommerce-expansion', 'eCommerce Expansion Programme', 'nkourouklis@kafkas.gr',
        (SELECT id FROM relay_users WHERE lower(email) = 'nkourouklis@kafkas.gr'));

INSERT OR IGNORE INTO relay_portfolio_members (portfolio_id, email, role) VALUES
 ('ptf-ecommerce-expansion', 'nkourouklis@kafkas.gr', 'owner'),
 ('ptf-ecommerce-expansion', 'ekareliotis@kafkas.gr', 'member'),
 ('ptf-ecommerce-expansion', 'smamouris@kafkas.gr', 'member'),
 ('ptf-ecommerce-expansion', 'mrapanakis@kafkas.gr', 'member');

INSERT OR IGNORE INTO projects (id, name, owner_email, co_owner_email, inbox_alias, portfolio_id, created_by_user_id) VALUES
 ('prj-b2b-cyprus', 'B2B Cyprus', 'ekareliotis@kafkas.gr', NULL, 'b2b-cyprus', 'ptf-ecommerce-expansion',
  (SELECT id FROM relay_users WHERE lower(email) = 'nkourouklis@kafkas.gr')),
 ('prj-b2c-greece-cyprus', 'B2C Greece & Cyprus', 'smamouris@kafkas.gr', 'mrapanakis@kafkas.gr', 'b2c-greece-cyprus', 'ptf-ecommerce-expansion',
  (SELECT id FROM relay_users WHERE lower(email) = 'nkourouklis@kafkas.gr'));

INSERT OR IGNORE INTO relay_project_members (id, project_id, email, invited_at, invite_status) VALUES
 ('pm-b2b-ekareliotis', 'prj-b2b-cyprus', 'ekareliotis@kafkas.gr', datetime('now'), 'sent'),
 ('pm-b2c-smamouris', 'prj-b2c-greece-cyprus', 'smamouris@kafkas.gr', datetime('now'), 'sent'),
 ('pm-b2c-mrapanakis', 'prj-b2c-greece-cyprus', 'mrapanakis@kafkas.gr', datetime('now'), 'sent');

INSERT OR IGNORE INTO relay_milestones (id, project_id, seq, name, tag, baseline_date, due_date) VALUES
 ('ms-b2b-01', 'prj-b2b-cyprus', 1, 'Analysis Workshops Complete', 'Analysis', '2026-11-05', '2026-11-05'),
 ('ms-b2b-02', 'prj-b2b-cyprus', 2, 'BRD Drop 1 Sign-off', 'BRD', '2026-11-09', '2026-11-09'),
 ('ms-b2b-03', 'prj-b2b-cyprus', 3, 'BRD Drop 2 Sign-off', 'BRD', '2026-11-23', '2026-11-23'),
 ('ms-b2b-04', 'prj-b2b-cyprus', 4, 'Technical Workshops Complete', 'Blueprint', '2026-11-20', '2026-11-20'),
 ('ms-b2b-05', 'prj-b2b-cyprus', 5, 'Blueprint Drop 1 Sign-off', 'Blueprint', '2026-12-02', '2026-12-02'),
 ('ms-b2b-06', 'prj-b2b-cyprus', 6, 'Blueprint Drop 2 Sign-off', 'Blueprint', '2026-12-18', '2026-12-18'),
 ('ms-b2b-07', 'prj-b2b-cyprus', 7, 'Development Complete', 'Development', '2027-03-12', '2027-03-12'),
 ('ms-b2b-08', 'prj-b2b-cyprus', 8, 'SIT Complete', 'SIT', '2027-03-31', '2027-03-31'),
 ('ms-b2b-09', 'prj-b2b-cyprus', 9, 'FAT Complete', 'FAT', '2027-03-31', '2027-03-31'),
 ('ms-b2b-10', 'prj-b2b-cyprus', 10, 'UAT Complete', 'UAT', '2027-05-10', '2027-05-10'),
 ('ms-b2b-11', 'prj-b2b-cyprus', 11, 'Readiness Complete', 'Readiness', '2027-04-09', '2027-04-09'),
 ('ms-b2b-12', 'prj-b2b-cyprus', 12, 'GO LIVE', 'GoLive', '2027-05-17', '2027-05-17'),
 ('ms-b2b-13', 'prj-b2b-cyprus', 13, 'Hypercare Complete', 'Hypercare', '2027-05-31', '2027-05-31'),
 ('ms-b2c-01', 'prj-b2c-greece-cyprus', 1, 'Business Analysis Workshops Complete', 'Analysis', '2026-11-16', '2026-11-16'),
 ('ms-b2c-02', 'prj-b2c-greece-cyprus', 2, 'BRD Greece Drop 1 Sign-off', 'BRD', '2026-11-18', '2026-11-18'),
 ('ms-b2c-03', 'prj-b2c-greece-cyprus', 3, 'BRD Greece Drop 2 Sign-off', 'BRD', '2026-12-02', '2026-12-02'),
 ('ms-b2c-04', 'prj-b2c-greece-cyprus', 4, 'BRD Cyprus Drop 1 Sign-off', 'BRD', '2026-12-18', '2026-12-18'),
 ('ms-b2c-05', 'prj-b2c-greece-cyprus', 5, 'BRD Cyprus Drop 2 Sign-off', 'BRD', '2027-01-13', '2027-01-13'),
 ('ms-b2c-06', 'prj-b2c-greece-cyprus', 6, 'UX/UI Drop 1 Sign-off', 'Blueprint', '2027-01-11', '2027-01-11'),
 ('ms-b2c-07', 'prj-b2c-greece-cyprus', 7, 'UX/UI Drop 2 Sign-off', 'Blueprint', '2027-02-11', '2027-02-11'),
 ('ms-b2c-08', 'prj-b2c-greece-cyprus', 8, 'Technical Blueprint Greece Sign-off', 'Blueprint', '2027-01-13', '2027-01-13'),
 ('ms-b2c-09', 'prj-b2c-greece-cyprus', 9, 'Technical Blueprint Cyprus Sign-off', 'Blueprint', '2027-02-02', '2027-02-02'),
 ('ms-b2c-10', 'prj-b2c-greece-cyprus', 10, 'Development Complete', 'Development', '2027-04-22', '2027-04-22'),
 ('ms-b2c-11', 'prj-b2c-greece-cyprus', 11, 'SIT Complete', 'SIT', '2027-04-29', '2027-04-29'),
 ('ms-b2c-12', 'prj-b2c-greece-cyprus', 12, 'FAT Complete', 'FAT', '2027-05-11', '2027-05-11'),
 ('ms-b2c-13', 'prj-b2c-greece-cyprus', 13, 'UAT Complete', 'UAT', '2027-06-15', '2027-06-15'),
 ('ms-b2c-14', 'prj-b2c-greece-cyprus', 14, 'Readiness Complete', 'Readiness', '2027-06-23', '2027-06-23'),
 ('ms-b2c-15', 'prj-b2c-greece-cyprus', 15, 'GO LIVE', 'GoLive', '2027-06-28', '2027-06-28'),
 ('ms-b2c-16', 'prj-b2c-greece-cyprus', 16, 'Hypercare Complete', 'Hypercare', '2027-07-12', '2027-07-12');
