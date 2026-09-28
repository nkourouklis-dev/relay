# Relay Handoff for Claude

**Snapshot:** 2026-09-28  
**Purpose:** Continue Relay + Microsoft Copilot Studio integration using the company's Claude account. This is a code/status handoff, not a deployment authorization.

**Cost constraint:** continue only in the company-managed Claude/Copilot environment. Do not request, add, or use personal API keys or paid model endpoints.

## Project

Relay is a Cloudflare Worker app with D1, Better Auth email OTP, Workers AI extraction, and a vanilla-JS UI. The existing live project URL is `https://kafkas-relay.pages.dev`. Read `AGENTS.md`, `.github/copilot-instructions.md`, and `docs/copilot-integration.md` before making further changes.

## Work Completed

- Replaced free-text owner entry with a project-member picker in new ask, extraction preview, and edit UI. Server validation limits new owners to the project creator or members. Existing legacy labels can be preserved without silently mapping them to an account. Changes are local/uncommitted in `public/index.html` and `src/index.js`.
- Added an official MCP TypeScript SDK endpoint at `/mcp` using Streamable HTTP.
- Added Entra delegated-token validation: tenant, API audience, `relay.access` scope, and an allow-list of Copilot OAuth client IDs. First allowed email match links to an immutable `(tenant_id, object_id)` identity record. No application-only token or shared admin key.
- Added MCP tools: `relay_list_projects`, `relay_list_asks`, `relay_preview_capture`, `relay_update_capture_draft`, and `relay_commit_capture`.
- Added a human approval gate. Copilot cannot approve a draft by sending a boolean. The same Relay user must open `public/mcp-approval.html`, review selected asks/owners/dates/quotes, and explicitly approve through a Better Auth session. Commit rechecks project access and owner membership.
- Transcript text is processed by the existing Relay extractor/Workers AI but is not persisted whole. D1 retains only extracted tasks, evidence quotes, and optional source title/URL. Unapproved drafts expire after 30 minutes; after approval, asks may be created for 30 minutes (enforced in `commitCapture`), and lapsed approvals are cleaned by the existing 15-minute cron. The approval page can also reject (only before approval) and create (same `commitCapture` as the MCP tool) via `POST /api/mcp-capture-drafts/:id/reject` and `/commit`. After commit, the draft's duplicate item JSON is cleared.
- Added additive migrations: `migrate_add_mcp_capture_drafts.sql`, `migrate_add_entra_identity_links.sql`, and `migrate_add_mcp_capture_approvals.sql`; all three have been applied to **local D1 only**.
- Added Entra/Copilot setup runbook at `docs/copilot-integration.md` and updated the product status in `docs/relay-product-owner-manual.md`.
- Added focused MCP auth tests in `test/relay-mcp.test.js`.
- Installed `@modelcontextprotocol/server`, `jose`, and `zod`. Updated Wrangler within v4 to `4.142.0` after audit findings; `npm audit` is now clear.

## Verification

- `npm test`: 29/29 passing.
- `npm run build`: Wrangler dry-run successful with Wrangler 4.142.0.
- `npm audit`: 0 vulnerabilities.
- Diagnostics: no errors in Worker, MCP module, approval page, or MCP test.
- Local browser: approval page preview/confirm interaction tested with a mocked draft; no D1 task was created by that mock.
- Local `/mcp` and OAuth metadata return `503` while Entra vars are absent. This is expected fail-closed behavior.
- Local dev server is running at `http://127.0.0.1:8787`.
- All changes are still uncommitted in the current worktree.
- No remote migrations, secrets, app registrations, or deployment have been changed.

## Activation Blockers

The Relay code is ready for tenant configuration, but **Copilot Studio is not connected to the KAFKAS tenant yet**. IT must provide/configure:

- `ENTRA_TENANT_ID`: KAFKAS tenant GUID.
- `ENTRA_API_AUDIENCE`: Relay API app client ID GUID (v2 token audience).
- `ENTRA_ALLOWED_CLIENT_IDS`: approved Copilot Studio OAuth client application ID(s), comma-separated if needed.
- An Entra API app registration exposing delegated scope `relay.access`.
- A Copilot Studio OAuth client registration, its wizard-generated redirect URI, delegated consent, and secure client credential stored in the Power Platform connection, not in this repository.

Then run the three migrations with `--remote`, deploy the Worker/Pages setup through the normal approved path, connect `https://kafkas-relay.pages.dev/mcp` in Copilot Studio, and pilot with one non-critical project. Follow the precise steps in `docs/copilot-integration.md`.

## Not Implemented Yet

- Automatic retrieval of Teams meeting transcripts through Microsoft Graph or Work IQ. For now, Copilot must provide the transcript/text to `relay_preview_capture`.
- Live meeting audio participation/recording.
- Legacy bare-name owner claim flow and canonical `asks.owner_user_id` linking. New UI assignments use member emails, but this identity cleanup is still outstanding.
- Production Entra settings, remote migrations, and deployment.

Do not add Graph transcript permissions or automatic transcript retention without KAFKAS IT/privacy approval. The inbound email handler and `/api/ingest` must remain unauthenticated. Never run the destructive full `schema.sql` against production; use only the additive migrations above.

## Suggested Next Prompt

> Continue from `docs/claude-handoff.md` and `docs/copilot-integration.md`. First verify the current MCP/Entra implementation and tests. Do not deploy, run remote migrations, or add secrets. Prepare an IT checklist for the three required Entra IDs, API/client app registrations, redirect URI, delegated scope/consent, and approved Copilot Studio sharing. Once IT supplies those values, configure them through the approved Cloudflare/Copilot Studio path and run a one-project pilot. Do not add Graph transcript retrieval until IT/privacy approval.