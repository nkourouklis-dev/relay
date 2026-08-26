# Relay — Next Phase: Email-Based Login

*Companion to `RELAY-OVERVIEW.md`. This is the implementation brief — paste it into Copilot/Opus along with the overview to bring it fully up to speed on the codebase before it starts making changes.*

**Goal:** every user is identified by exactly one thing — their email address. Logging in and "ownership" both resolve to the same email-keyed identity, so `Κώστας` and `vendor@acme.com` can never again be two different, unlinked records for what might be the same person.

---

## 1. Recommended Approach

**Use [Better Auth](https://better-auth.com) with its Magic Link plugin, on top of your existing D1 database, plus a transactional email provider for sending the links.**

### Why this, and not the alternatives

| Option | Verdict |
|---|---|
| **Better Auth + magic link (recommended)** | Open source, self-hosted (no new vendor lock-in, no per-user pricing), and as of its 1.5 release it has **native first-class Cloudflare D1 support** — you pass your existing `env.DB` binding directly, no adapter boilerplate. It has a purpose-built magic-link plugin (passwordless, rate-limited, single-use tokens) that matches "login via email" exactly. It runs fine in a plain Worker `fetch` handler — you don't need to adopt a framework like Hono just to use it. |
| **Clerk** (your own README already floats this) | Fully managed, very fast to wire up, handles everything for you — but it's a paid SaaS dependency once you're past free-tier volume, and it's a bigger philosophical shift for a project whose whole ethos is "self-hosted, own your data" (see the README: "Χρειάζεσαι μόνο Cloudflare"). Reasonable fallback if you'd rather not maintain any auth code at all. |
| **Hand-rolled magic link** (what I sketched previously) | Doable, but you'd be reimplementing token expiry, single-use enforcement, rate-limiting, and session handling from scratch — exactly the part Better Auth already ships, tested, for this exact stack. Not worth it now that native D1 support exists. |
| **Auth.js / NextAuth D1 adapter** | Exists and works, but it's designed around Next.js conventions; retrofitting it onto a bare Worker is more friction than Better Auth's direct-binding approach. |

**Verdict: Better Auth.** It's the option that fits your stack today with the least new surface area, keeps you self-hosted, and directly ships the "email address = login" magic-link flow you asked for.

### The one piece you still need to add regardless of auth library

Cloudflare Email Routing (which Relay already uses) is **inbound-only** — it cannot send the magic-link email. You need a transactional email API. Pick one:
- **Resend** — simplest setup, generous free tier, popular pairing with Cloudflare Workers.
- **Postmark** — also solid, slightly more enterprise-flavored.

Either works; Resend is the path of least resistance for an indie/solo project. This is a new account + a new secret (`RESEND_API_KEY`) in `wrangler.jsonc`, nothing more.

---

## 2. Implementation Plan (phases, in order)

### Phase A — Users table & identity backfill
- Add a `users` table:
  ```sql
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  ```
- Write this as an additive migration file (`migrate_add_users.sql`), following the exact pattern of the existing `migrate_add_ownership.sql` — no `DROP TABLE`, safe to run against production data.
- **Backfill decision needed from you, not Copilot:** for each distinct current value of `asks.owner` (`vendor@acme.com`, `pm@internal.com`, `you@example.com`, `Κώστας`, `Ελένη`, `Άννα`), decide which are the same person as which email. Anything that's already a valid email can auto-create a `users` row. Bare names (`Κώστας`, `Ελένη`, `Άννα`) cannot be safely auto-linked — they need either a manual mapping from you, or they stay as unclaimed placeholder users until that person logs in themselves (see Phase D).
- Add `owner_user_id TEXT REFERENCES users(id)` to `asks`, keeping the old `owner` text column as a fallback label for anything not yet linked.

### Phase B — Better Auth wiring
- `npm install better-auth`
- Add the Better Auth handler to `src/index.js`, pointed at `env.DB`:
  ```js
  import { betterAuth } from "better-auth";
  import { magicLink } from "better-auth/plugins";

  const auth = betterAuth({
    database: env.DB, // your existing D1 binding — no adapter needed
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // call Resend (or Postmark) here to actually send `url` to `email`
        },
      }),
    ],
  });
  ```
- Route all `/api/auth/*` paths to `auth.handler(request)` at the top of your existing routing chain, before your current `if (path === ...)` checks.
- Add `RESEND_API_KEY` (or equivalent) as a Cloudflare secret; add the Resend call inside `sendMagicLink`.
- Better Auth manages its own session/user/token tables automatically via the D1 binding — you don't need to hand-design those, only your app-specific `users`-to-`asks` link from Phase A. (Decide whether Better Auth's own user table *is* your `users` table, or whether you keep a lightweight app-level `users` table that references it — recommended: let Better Auth own the canonical user record, and treat Phase A's `users` table as that same table rather than a duplicate. Adjust Phase A's schema to match Better Auth's expected user schema once you scaffold it, rather than running both in parallel.)

### Phase C — Protect the right routes, and *only* those
- Add a small auth-check helper used at the top of the mutating/reading routes that should require login: `/api/asks` (GET & POST), `/api/projects` (GET & POST), `/api/dashboard`, `/api/dashboard/summary`.
- **Explicitly do NOT put this check in front of:**
  - the `email` handler (inbound capture)
  - `/api/ingest` (paste-to-extract / server-side ingestion)
  
  These must keep working without a logged-in session — that's the core "magic" of the product.
- Add a login screen to `public/index.html` (email input → "send me a link" → check your inbox), and a logged-out state that hides the ask list/dashboard until authenticated.

### Phase D — Replace free-text owner with real identity, and the "claim" flow
- Change the "owner" field in the new-ask UI from a free-text box to a picker of known users (by email) — going forward, no more bare-name entry.
- For the legacy bare-name asks left over from Phase A's backfill (`Κώστας`, `Ελένη`, `Άννα`, `(χωρίς owner)`): add a simple "claim this" affordance — once someone logs in with their real email, they can see any unclaimed asks with a matching name and attach them to their account. This is the actual fix for the duplication problem; everything before this phase is just infrastructure to make it possible.

### Phase E — Decide scope on multi-user projects
Before Phase D ships fully, settle: is a "project" single-owner (just you), or do vendor/PM/teammates each get their own login into the *same* project? The current schema (`projects.owner_email`, singular) suggests single-owner today. If you want shared projects, you'll need a `project_members` join table. **This is a product decision, not a coding one — make the call before Copilot builds the picker UI in Phase D**, since it changes what that UI needs to do.

### Phase F — Migrate & cut over
- Run the new migration against local D1, verify, then run against remote/production (`npm run db:remote`-style) following the existing safe pattern.
- Update `README.md`'s setup steps to mention the new `RESEND_API_KEY` (or equivalent) requirement.
- Remove/hide the old free-text owner entry point once the picker is live.

---

## 3. Open Decisions You Should Make Before Handing This to Copilot

1. **Backfill mapping** — which of `Κώστας` / `Ελένη` / `Άννα` correspond to real emails you already know, vs. which should wait for a self-service claim.
2. **Resend vs. Postmark** (or another provider) — pick one so Copilot isn't guessing.
3. **Single-owner vs. multi-user projects** (Phase E) — affects how big the Phase D UI work is.
4. Whether you want Better Auth's own user/session tables to *be* your canonical `users` table (recommended) or to layer your own table on top — recommended is the former, to avoid maintaining two parallel identity systems.

---

## 4. Suggested First Prompt to Copilot/Opus

> *"I'm attaching two files: RELAY-OVERVIEW.md (what this project is and how it currently works) and RELAY-AUTH-PHASE-PLAN.md (the next phase I want to build: email-based login using Better Auth with its magic-link plugin on Cloudflare D1, plus [Resend/Postmark] for sending the emails). Start with Phase A — write the additive users migration and update schema.sql accordingly, without touching or dropping any existing data. Ask me before making the backfill decision for the bare-name owners."*

That scopes the first working session tightly to one reviewable change instead of asking it to build the whole thing at once.
