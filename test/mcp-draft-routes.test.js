import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";

// Ελάχιστος D1-συμβατός adapter πάνω σε in-memory SQLite: τρέχει το πραγματικό SQL του Worker.
function createD1(db) {
  const statement = (sql) => ({
    binds: [],
    bind(...values) { this.binds = values; return this; },
    async first() { return db.prepare(sql).get(...this.binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...this.binds) }; },
    async run() {
      const result = db.prepare(sql).run(...this.binds);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    prepare: statement,
    async batch(statements) {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
  };
}

const ORIGIN = "http://127.0.0.1:8787";
const DEV_USER = "local-development-user"; // ο dev actor του Worker σε localhost (admin)
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  // Το schema.sql φέρνει demo asks. Τα αφαιρούμε (μόνο στη in-memory βάση) ώστε τα counts των tests να ξεκινούν από 0.
  db.exec("DELETE FROM events; DELETE FROM asks;");
  const now = new Date().toISOString();
  const addUser = db.prepare(
    "INSERT INTO relay_users (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 1, ?, ?, ?)"
  );
  addUser.run(DEV_USER, "Local Development", "dev@local.relay", now, now, "admin");
  addUser.run("other-user", "Other", "other@kafkas.gr", now, now, "user");
  db.prepare("INSERT INTO projects (id, name, inbox_alias, created_by_user_id) VALUES ('p1', 'Test project', 'test', ?)").run(DEV_USER);
  db.prepare(
    "INSERT INTO relay_project_members (id, project_id, email, invited_at) VALUES ('m1', 'p1', 'member@kafkas.gr', ?)"
  ).run(now);
  const env = { DB: createD1(db) };
  return { db, env };
}

function seedDraft(db, { id = "11111111-1111-4111-8111-111111111111", actor = DEV_USER, expiresInMs = 30 * 60 * 1000, selected = true } = {}) {
  const items = [
    { title: "Στείλε το BRD", due_date: "2026-10-01", owner: "member@kafkas.gr", quote: "Ο Κώστας θα στείλει το BRD", owner_suggestion: null, selected },
    { title: "Test plan", due_date: "", owner: "", quote: "Test plan μέχρι Δευτέρα", owner_suggestion: null, selected },
  ];
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_mcp_capture_drafts (id, project_id, actor_user_id, source_title, source_url, items_json, status, created_at, expires_at)
     VALUES (?, 'p1', ?, 'Πρακτικά', '', ?, 'pending', ?, ?)`
  ).run(id, actor, JSON.stringify(items), new Date(now).toISOString(), new Date(now + expiresInMs).toISOString());
  return id;
}

function call(env, method, path, { origin = ORIGIN, body } = {}) {
  const headers = { host: "127.0.0.1:8787" };
  if (origin) headers.origin = origin;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(
    new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env
  );
}
const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;
const askCount = (db) => count(db, "SELECT COUNT(*) AS c FROM asks");
const approve = (env, id) => call(env, "POST", `/api/mcp-capture-drafts/${id}`, { body: { approve: true } });

test("GET exposes what the page may do before approval", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  const data = await (await call(env, "GET", `/api/mcp-capture-drafts/${id}`)).json();
  assert.deepEqual([data.can_approve, data.can_reject, data.can_create, data.approved], [true, true, false, false]);
});

test("reject before approval deletes the draft and creates nothing", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  const response = await call(env, "POST", `/api/mcp-capture-drafts/${id}/reject`);
  assert.equal(response.status, 200);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_drafts"), 0);
  assert.equal(askCount(db), 0);
  assert.equal((await call(env, "GET", `/api/mcp-capture-drafts/${id}`)).status, 404);
});

test("reject after approval is refused and the approval record is untouched", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  assert.equal((await approve(env, id)).status, 200);
  const response = await call(env, "POST", `/api/mcp-capture-drafts/${id}/reject`);
  assert.equal(response.status, 409);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_approvals"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_drafts"), 1);
});

test("create without approval is refused and creates nothing", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  const response = await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /εγκριθεί/);
  assert.equal(askCount(db), 0);
});

test("approve then create makes exactly the approved asks, once", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  await approve(env, id);
  assert.equal(askCount(db), 0, "approval alone must not create asks");

  const created = await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`);
  assert.equal(created.status, 200);
  const result = await created.json();
  assert.equal(result.created, 2);
  assert.equal(askCount(db), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM asks WHERE status = 'open' AND created_by_user_id = ?", DEV_USER), 2);

  const view = await (await call(env, "GET", `/api/mcp-capture-drafts/${id}`)).json();
  assert.equal(view.status, "committed");
  assert.equal(view.created_count, 2);
  assert.deepEqual(view.items, []);
  assert.equal(view.can_create, false);

  const again = await (await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`)).json();
  assert.equal(again.already_committed, true);
  assert.equal(askCount(db), 2, "a second create must not duplicate asks");
});

test("only selected proposals are created", async () => {
  const { db, env } = setup();
  const id = seedDraft(db, { selected: false });
  await approve(env, id);
  const response = await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`);
  assert.equal(response.status, 409);
  assert.equal(askCount(db), 0);
});

test("approval older than 30 minutes cannot create asks", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  await approve(env, id);
  db.prepare("UPDATE relay_mcp_capture_approvals SET approved_at = ? WHERE draft_id = ?")
    .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), id);

  const view = await (await call(env, "GET", `/api/mcp-capture-drafts/${id}`)).json();
  assert.deepEqual([view.can_create, view.approval_expired, view.can_reject], [false, true, false]);

  const response = await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /έγκριση έληξε/);
  assert.equal(askCount(db), 0);
});

test("approval within the window can still create asks", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  await approve(env, id);
  db.prepare("UPDATE relay_mcp_capture_approvals SET approved_at = ? WHERE draft_id = ?")
    .run(new Date(Date.now() - 25 * 60 * 1000).toISOString(), id);
  assert.equal((await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`)).status, 200);
  assert.equal(askCount(db), 2);
});

test("POST reject and create require a matching Origin", async () => {
  const { db, env } = setup();
  const id = seedDraft(db);
  await approve(env, id);
  for (const action of ["reject", "commit"]) {
    assert.equal((await call(env, "POST", `/api/mcp-capture-drafts/${id}/${action}`, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call(env, "POST", `/api/mcp-capture-drafts/${id}/${action}`, { origin: null })).status, 403);
  }
  assert.equal(askCount(db), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_drafts"), 1);
});

test("another user's draft is invisible to reject and create", async () => {
  const { db, env } = setup();
  const id = seedDraft(db, { actor: "other-user" });
  db.prepare("INSERT INTO relay_mcp_capture_approvals (draft_id, approved_by_user_id, approved_at) VALUES (?, 'other-user', ?)")
    .run(id, new Date().toISOString());
  assert.equal((await call(env, "GET", `/api/mcp-capture-drafts/${id}`)).status, 404);
  assert.equal((await call(env, "POST", `/api/mcp-capture-drafts/${id}/reject`)).status, 404);
  assert.equal((await call(env, "POST", `/api/mcp-capture-drafts/${id}/commit`)).status, 404);
  assert.equal(askCount(db), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_drafts"), 1);
});

test("cleanup drops approvals older than 30 minutes and keeps recent ones", async () => {
  const { db, env } = setup();
  // Ρεαλιστικά: ένα draft που εγκρίθηκε πριν 31' έχει ήδη λήξει (η έγκριση γίνεται μόνο πριν τη λήξη του).
  const stale = seedDraft(db, { id: "22222222-2222-4222-8222-222222222222", expiresInMs: -10 * 60 * 1000 });
  const fresh = seedDraft(db, { id: "33333333-3333-4333-8333-333333333333" });
  const insert = db.prepare("INSERT INTO relay_mcp_capture_approvals (draft_id, approved_by_user_id, approved_at) VALUES (?, ?, ?)");
  insert.run(stale, DEV_USER, new Date(Date.now() - 31 * 60 * 1000).toISOString());
  insert.run(fresh, DEV_USER, new Date(Date.now() - 5 * 60 * 1000).toISOString());

  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);

  const remaining = db.prepare("SELECT id FROM relay_mcp_capture_drafts").all().map((row) => row.id);
  assert.deepEqual(remaining, [fresh]);
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM relay_mcp_capture_approvals"), 1);
});

test("inbound /api/ingest still works without a session", async () => {
  const { db, env } = setup();
  const response = await worker.fetch(
    new Request("https://relay.example.com/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p1", type: "note", subject: "x", body: "Please send the BRD by 2026-10-01", sender: "a@b.gr" }),
    }),
    env
  );
  assert.equal(response.status, 200);
  assert.ok(askCount(db) >= 1);
});
