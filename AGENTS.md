# AGENTS.md — Relay

Operational instructions for any coding agent working in this repo (GitHub Copilot coding agent, Claude, or otherwise). Complements `.github/copilot-instructions.md`, which has the narrative project context — this file is the "how to actually work in here" checklist.

## Setup

```bash
npm install
npx wrangler login
npm run db:local
npm run dev        # verify it boots before making changes
```

If `wrangler dev` fails to start, stop and report the error rather than working around it silently — it usually means a missing `database_id` in `wrangler.jsonc` or a missing binding, both of which need a human's Cloudflare account details.

## Scope discipline

- Work **one phase at a time** against `RELAY-AUTH-PHASE-PLAN.md`. Each phase in that plan is meant to land as its own reviewable change — do not combine Phase A (users table) and Phase B (auth wiring) into one giant diff.
- Before starting a phase, restate in your response which phase you're doing and what you are **not** doing yet, so the human can catch scope creep early.
- If a phase has an "open decision" flagged as needing human input (see plan file, §3), stop and ask rather than picking an answer yourself.

## Validation before proposing a change is "done"

There's no test suite yet, so validation is manual:

1. Does `npm run dev` still start cleanly?
2. For schema changes: does `npm run db:local` apply without error, and does existing demo data (from `schema.sql`) survive untouched?
3. For route changes: confirm the unauthenticated paths (email handler, `/api/ingest`) still work without a session — this is the constraint most likely to be silently broken.
4. For UI changes: does `public/index.html` still load with no console errors, in both a logged-out and logged-in state once auth exists?

## Commit / PR conventions

- Keep commits scoped to one phase or one logical change.
- In the PR description, name which phase of `RELAY-AUTH-PHASE-PLAN.md` this addresses, and explicitly list any open decisions you had to leave for the human reviewer rather than guessing.
- Flag any new dependency (e.g. `better-auth`, an email-provider SDK) and any new required secret (e.g. `RESEND_API_KEY`) clearly at the top of the PR description — these need to be added to the Cloudflare dashboard/`wrangler.jsonc` by a human, not by the agent.

## Things to never do without being asked

- Don't `DROP` or destructively rewrite any existing table.
- Don't add an auth check to the inbound email handler or `/api/ingest`.
- Don't swap the project to a framework (Hono, etc.) or add a build step.
- Don't auto-map ambiguous owner names (e.g. a bare first name) to a specific email — that's a human decision.
