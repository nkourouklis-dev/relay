# Relay — Project Overview

*Prepared as a briefing document for continuing development in GitHub Copilot / Claude Opus. This describes the project exactly as it exists in the current codebase (`relay-updated.zip`), plus the demo data currently in it (`relay-demo-project-dashboard.xlsx` / `.pptx`).*

---

## 1. What Relay Is

Relay is a small, self-hosted **project-tracking tool that fills itself in from email**. Instead of a PM manually logging tasks in a board, the idea is: people keep emailing/chatting the way they already do, and Relay watches an inbox, pulls out the concrete commitments buried in that correspondence ("can you send the updated BRD by Wednesday", "let's lock UAT for the 30th"), and turns each one into a tracked item — called an **"ask"** — with an owner, a due date, and a status.

It's built as a single Cloudflare Worker backed by a Cloudflare D1 (SQLite) database, with a minimal HTML/JS front end. No separate backend server, no separate hosting — it's meant to be `wrangler deploy`-able as one unit, in line with the project's own description of itself as an "MVP starter."

**One-line pitch:** *Project tracking that lives on its own — send it an email, and it turns your commitments into a tracked list of who-owes-what-by-when.*

---

## 2. What It Does (Features)

1. **Capture-by-email.** You point a Cloudflare Email Routing rule (catch-all on a subdomain, e.g. `in.relay.app`) at the Worker. Any email sent to an address under that domain is parsed (via the `postal-mime` library) and scanned for action items, decisions, commitments, risks, and blockers. The local part of the destination address (e.g. `demo@in.relay.app`) becomes the project alias, so different projects can each have their own capture address.
2. **Asks.** Each extracted item is stored as an "ask" — a single unit of work with:
   - `title` — what's being asked
   - `owner` — who's on the hook for it (currently free text — see §5, this is the crux of the problem you're solving)
   - `requested_by` — who asked for it
   - `due_date`
   - `status` — `open`, `accepted`, `done`, or flagged `overdue`
   - `source_quote` — the exact original text it was extracted from, kept for trust/traceability
   - `kind` — action / decision / commitment / risk / blocker
3. **Dashboard.** A summary view (totals, open/accepted/done/overdue counts), a breakdown by owner, and a breakdown by who created the ask. This is what's exported in the `.xlsx` / `.pptx` dashboard files you shared.
4. **AI executive summary.** The dashboard includes an auto-generated natural-language summary ("The project has 7 items, 5 of which are open and 2 overdue...") plus a "Highlights" and "Risks" section, generated from the current data.
5. **Overdue detection.** A scheduled cron job re-evaluates due dates and flags items as overdue automatically.
6. **Manual entry / paste-to-extract.** The UI also lets someone paste in text (e.g. minutes of a meeting) directly and run the same extraction logic on it, without needing an actual email.
7. **Naive extraction today, AI extraction later.** The current extraction logic (`naiveExtract` in `src/index.js`) is a simple heuristic parser. The README already flags the intended upgrade path: turn on Workers AI and swap in `extractWithAI` for proper natural-language extraction.

---

## 3. How It Works (Architecture)

```
Inbound email  ──▶  Cloudflare Email Routing  ──▶  Worker email handler
                                                        │
                                                        ▼
                                                  naiveExtract()
                                                        │
                                                        ▼
                                              D1: sources + asks tables
                                                        │
                          ┌─────────────────────────────┼─────────────────────────────┐
                          ▼                              ▼                             ▼
                  GET /api/asks                 GET /api/dashboard          Cron (scheduled) ──▶ overdue re-check
                  POST /api/asks                 GET /api/dashboard/summary
                  GET /api/projects
                  POST /api/projects
                  POST /api/ingest  (paste-to-extract, no email needed)
                          │
                          ▼
                  public/index.html (single-page UI: list, filters, new-ask form, dashboard)
```

**Stack:**
- **Runtime:** Cloudflare Workers (`src/index.js`, ~22KB, one file, one `export default { fetch, email, scheduled }` handler)
- **Database:** Cloudflare D1 (SQLite), schema in `schema.sql`
- **Routing:** hand-written `if (path === "..." && request.method === "...")` chain inside the single `fetch` handler — there is no framework (no Hono, no itty-router) and no middleware layer today
- **Email parsing:** `postal-mime` npm package
- **Frontend:** one static `public/index.html` (~33KB), vanilla JS, no build step, no framework
- **Config:** `wrangler.jsonc` — this is where D1 bindings, and later any AI/secrets bindings, get declared
- **Deployment:** `npm run dev` (local), `npm run deploy` (production), `npm run db:local` / `db:remote` to apply `schema.sql`

**Data model (current):**

| Table | Purpose | Key columns |
|---|---|---|
| `projects` | One row per tracked project | `id`, `name`, `owner_email`, `inbox_alias` (unique — this is the `demo@` in `demo@in.relay.app`) |
| `sources` | Every raw email/chat/note/file that came in | `id`, `project_id`, `type`, `sender`, `subject`, `body` |
| `asks` | The actual tracked commitments | `id`, `project_id`, `source_id`, `kind`, `title`, `owner`, `requested_by`, `due_date`, `status`, `confidence`, `source_quote`, `created_by` (added in a later migration) |
| `events` | Timeline per ask (created / restated / slipped / completed) | `id`, `ask_id`, `type`, `note` |

Note: `owner` and `requested_by` on `asks` are **plain text columns**, not foreign keys to any user table — there is no `users` table in the schema at all today. That's the root of the identity-duplication problem described below.

---

## 4. Current Snapshot (from the demo dashboard you shared)

As of 2026-08-26, the demo project has:
- **7 total asks** — 5 open, 1 accepted, 1 done, 2 overdue
- **Owners on file:** `vendor@acme.com`, `pm@internal.com`, `you@example.com`, plus bare first names `Κώστας`, `Ελένη`, `Άννα`, and one item with `(χωρίς owner)` — "no owner"
- **Overdue items:** sending the updated BRD (owner `vendor@acme.com`, due 2026-08-20), and the MVP-scope decision (owner `you@example.com`, due 2026-08-25)
- **Creators:** most asks (4 of 7) were created by "Nikos"; 3 have no recorded creator

This is a live illustration of the exact problem you flagged: `Κώστας` and `vendor@acme.com` and `you@example.com` are three different *strings* in the `owner` column, but there's no guarantee they're three different *people* — and no way for the system to merge or verify identity.

---

## 5. The Problem You're Solving Next

**Right now, "who owns this" is just a text field.** Anyone creating an ask can type any name or email into `owner`, with no verification and no link to an actual account — because there *is* no account system. This causes:
- **Duplicate identities**: the same real person can appear as `Κώστας` in one ask and as an email address in another, with the dashboard counting them as two separate owners.
- **No accountability**: nothing stops a typo or a made-up name from becoming an "owner."
- **No access control**: anyone who can reach the API can create or read asks for any project — there's no concept of "this is my project" vs. "this is yours."

**What you asked for:** login via email, so that email address *is* the identity — one account per email, no separate name-based accounts, so ownership converges on a single canonical identifier per person instead of fragmenting.

This is the subject of the companion document, `RELAY-AUTH-PHASE-PLAN.md`, which lays out the recommended approach and a step-by-step implementation plan sized for Copilot/Opus to execute directly against this codebase.

---

## 6. File Inventory (what's in the current zip)

| File | Role |
|---|---|
| `src/index.js` | The entire Worker: routing, email handler, extraction logic, cron |
| `public/index.html` | The entire frontend UI |
| `schema.sql` | Full DB schema + demo seed data |
| `migrate_add_ownership.sql` | Example of the project's migration pattern (additive `ALTER TABLE`, safe to run twice — a model to follow for the users-table migration) |
| `wrangler.jsonc` | Cloudflare bindings/config |
| `package.json` | Dependencies: `postal-mime` (runtime), `wrangler` (dev) |
| `README.md` | Setup instructions (in Greek) + the project's own stated "next steps," which already name Workers AI, R2, Vectorize, and **auth (Clerk)** as future additions |
| `public/DIABASE_PRWTA.txt` | Greek-language patch note describing a UI update (delete-project button, overdue-as-badge, help text, sample MoM button) — informational, not code to build from |
| `test-email.txt` | A sample raw email used for testing the capture pipeline |

---

## 7. Constraints Worth Keeping in Mind for Any Next Phase

- **The capture-by-email path must stay unauthenticated.** It's triggered by Cloudflare's mail infrastructure, not a logged-in user — any auth work must not put a login wall in front of the `email` handler or `/api/ingest`.
- **No outbound email exists in this stack yet.** Cloudflare Email Routing is inbound-only. Anything that needs to *send* mail (like a login link) needs a new, separate outbound email provider wired in.
- **Single-file, no-framework style is intentional** (this is an MVP "starter" meant to be simple to read and deploy) — worth deciding whether to preserve that style or introduce structure (e.g. Hono) when adding auth.
- **This is a solo-maintained, live project** already ingesting real email — changes to the schema should follow the existing safe/additive migration pattern (`migrate_add_ownership.sql`), not destructive rewrites.
