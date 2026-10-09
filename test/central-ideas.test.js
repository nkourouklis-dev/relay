import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";

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
const DEV_USER = "local-development-user"; // admin σε localhost
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO relay_users (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, 'Dev', 'dev@local.relay', 1, ?, ?, 'admin')").run(DEV_USER, now, now);
  db.prepare("INSERT INTO projects (id, name, inbox_alias, created_by_user_id) VALUES ('b2b', 'B2B GR', 'b2b', ?)").run(DEV_USER);
  return { db, env: { DB: createD1(db) } };
}

function call(env, method, path, body) {
  const headers = { host: "127.0.0.1:8787", origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
}

test("ideas are central: general ideas live in the hub, project ideas keep their project as a tag", async () => {
  const { db, env } = setup();
  assert.equal((await call(env, "POST", "/api/ideas", { title: "Κοινό knowledge base" })).status, 200);
  assert.equal((await call(env, "POST", "/api/ideas", { title: "Checklist cutover", project_id: "b2b" })).status, 200);

  const ideas = await (await call(env, "GET", "/api/ideas")).json();
  assert.equal(ideas.length, 2);
  const general = ideas.find((i) => i.title === "Κοινό knowledge base");
  const scoped = ideas.find((i) => i.title === "Checklist cutover");
  assert.equal(general.project_id, "relay-ideas-hub");
  assert.equal(general.project_name, null);
  assert.equal(scoped.project_name, "B2B GR");

  const summary = await (await call(env, "GET", "/api/ideas/summary")).json();
  assert.equal(summary.total, 2);
  const activity = await (await call(env, "GET", "/api/ideas/activity?limit=5")).json();
  assert.equal(activity.length, 2);
  assert.equal((await call(env, "POST", "/api/ideas", { title: "x", project_id: "nope" })).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM relay_ideas").get().c, 2);
});

test("the ideas hub never shows up or behaves as a project", async () => {
  const { env } = setup();
  const projects = await (await call(env, "GET", "/api/projects")).json();
  assert.deepEqual(projects.map((p) => p.id), ["demo", "b2b"].filter((id) => projects.some((p) => p.id === id)));
  assert.ok(!projects.some((p) => p.id === "relay-ideas-hub"));
  assert.equal((await call(env, "DELETE", "/api/projects/relay-ideas-hub")).status, 400);

  const ingest = await worker.fetch(new Request(ORIGIN + "/api/ingest", {
    method: "POST", headers: { host: "127.0.0.1:8787", "content-type": "application/json" },
    body: JSON.stringify({ project_id: "relay-ideas-hub", body: "Στείλε το BRD μέχρι Τετάρτη" }),
  }), env);
  assert.equal(ingest.status, 400);
});
