---
applyTo: "src/**,schema.sql,migrate_*.sql,wrangler.jsonc,package.json,public/index.html"
---

# Instructions — Email-Login / Auth Phase

These apply specifically while implementing the email-login work described in `RELAY-AUTH-PHASE-PLAN.md`.

## Approach to build

- **Auth library:** Better Auth, using its magic-link plugin, with the D1 binding (`env.DB`) passed directly — Better Auth has native D1 support, so do not add a separate ORM/adapter layer unless one is already in use.
- **Outbound email:** the actual "send this magic link" call goes through a transactional email provider (Resend by default, per the plan file) — this is a new secret (`RESEND_API_KEY` or equivalent), not something to implement as raw SMTP.
- **Session/user tables:** prefer letting Better Auth own the canonical user/session schema rather than hand-rolling a parallel `users` table. If a project-specific `users` table already exists from an earlier phase, reconcile it with Better Auth's schema rather than keeping two separate identity tables — ask if it's unclear which should be canonical.

## Route boundaries (critical)

When adding the Better Auth handler and any auth-check middleware to `src/index.js`:

- **Protect:** `GET/POST /api/asks`, `GET/POST /api/projects`, `GET /api/dashboard`, `GET /api/dashboard/summary`.
- **Never protect:** the `email` export handler, and `POST /api/ingest`. These are invoked by Cloudflare's mail infrastructure and by the paste-to-extract feature, not by a logged-in browser — adding a session check here breaks the product's core capture flow.

## Data migration rules

- Any schema change is a new additive file (e.g. `migrate_add_users.sql`), following the exact style of `migrate_add_ownership.sql`: `ALTER TABLE ... ADD COLUMN`, idempotent/safe to re-run, no `DROP TABLE`.
- Existing `asks.owner` values that are already valid email addresses may be auto-linked to a new user record. Existing bare-name values (non-email strings) must **not** be silently auto-linked to any specific email — leave them as unclaimed/unlinked and surface them for a human decision or a self-service "claim" flow, per Phase D of the plan.

## UI

- Add a login screen (email input → "check your inbox" state) to `public/index.html` without introducing a bundler or framework — match the existing vanilla-JS, single-file style.
- Match existing language conventions in the section you're editing (the current UI mixes Greek and English by section — don't translate unrelated existing strings).
