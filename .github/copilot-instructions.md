# Copilot Instructions — Relay

This file is repository-wide context for GitHub Copilot (Chat, coding agent, and code review). Read this before exploring the codebase — it should save you from re-discovering things via grep.

## What this project is

Relay is a project-tracking tool that fills itself in from email. A Cloudflare Worker watches an inbox (via Cloudflare Email Routing), extracts action items/decisions/commitments from incoming mail into tracked "asks" (owner, due date, status), and exposes a small dashboard UI. Full narrative: see `RELAY-OVERVIEW.md` in the repo root if present — read it in full before making architectural changes.

## Stack & structure

- **Runtime:** Cloudflare Workers, single entry point `src/index.js` — one `export default { fetch, email, scheduled }` handler. No framework (no Hono/itty-router) today.
- **Database:** Cloudflare D1 (SQLite). Schema: `schema.sql`. Migrations are separate additive files, e.g. `migrate_add_ownership.sql`.
- **Frontend:** single static file `public/index.html`, vanilla JS, no build step, no bundler.
- **Email parsing:** `postal-mime` npm package.
- **Config/secrets:** `wrangler.jsonc` (bindings) + Cloudflare Worker secrets (never hardcode secrets in source).

## Build, run, verify

```bash
npm install
npx wrangler login          # one-time, opens browser
npm run db:local            # apply schema.sql to local D1
npm run dev                 # wrangler dev, local run at http://localhost:8787
npm run db:remote           # apply schema.sql to production D1 (careful — production)
npm run deploy               # deploy to production
```

There is **no automated test suite** in this repo yet. Do not assume `npm test` exists or invent test output — verify behavior by reasoning through the code and, where possible, running `wrangler dev` locally. If you add meaningful new logic (e.g. auth flows), proposing a minimal test setup is welcome, but call it out explicitly as a new addition rather than assuming one exists.

## Hard constraints — do not violate these

1. **The inbound email handler and `POST /api/ingest` must stay unauthenticated.** They're invoked by Cloudflare's mail infrastructure and by paste-to-extract, not by a logged-in browser session. Never add an auth/session check in front of either.
2. **Migrations are additive only.** Follow the pattern in `migrate_add_ownership.sql` (`ALTER TABLE ... ADD COLUMN`, safe to run twice, never `DROP TABLE` on a table that may hold production data). This is a live, solo-maintained project already ingesting real email — do not propose destructive schema rewrites.
3. **Don't introduce a framework or restructure the single-file Worker** unless explicitly asked. The single-file, no-build-step style is intentional for this "MVP starter."
4. **UI copy is mixed Greek/English.** Match the language already used in the section of `public/index.html` you're editing — don't translate existing strings unless asked.
5. **Ask before making irreversible or ambiguous data decisions** (e.g. how to map an existing free-text `owner` value to a real user record) rather than guessing — see the open decisions list in `RELAY-AUTH-PHASE-PLAN.md` if present.

## Current active phase

The project is mid-way through adding **email-based login**, so that a user's email address is their sole identity (fixing the current state where `asks.owner` is free text and the same person can appear under multiple unlinked names/emails). The approach, phased plan, and rationale are fully specified in `RELAY-AUTH-PHASE-PLAN.md` — read it before touching auth-related code. Work one phase at a time; don't jump ahead to a later phase without being asked, and don't skip the "open decisions" that file flags as requiring a human answer.

See also `.github/instructions/relay-auth.instructions.md` for instructions scoped specifically to files touched during this phase.
