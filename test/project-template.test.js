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
  db.exec("DELETE FROM events; DELETE FROM asks;");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO relay_users (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, 'Dev', 'dev@local.relay', 1, ?, ?, 'admin')").run(DEV_USER, now, now);
  db.prepare("INSERT INTO projects (id, name, inbox_alias, created_by_user_id) VALUES ('b2b', 'B2B GR', 'b2b', ?)").run(DEV_USER);
  db.prepare("INSERT INTO relay_project_members (id, project_id, email, invited_at, invite_status) VALUES ('m1','b2b','maria@kafkas.gr',?,'accepted')").run(now);
  db.prepare("INSERT INTO relay_board_columns (id, project_id, group_by, column_key, label, sort_order) VALUES ('c1','b2b','section','UAT','UAT',1)").run();
  const addAsk = db.prepare(
    `INSERT INTO asks (id, project_id, title, owner, due_date, status, section, priority, story_points, go_live_blocking, sprint_id, external_import_key)
     VALUES (?, 'b2b', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );
  addAsk.run("t1", "Smoke test παραγωγής", "maria@kafkas.gr", "2026-10-01", "done", "UAT", "critical", 5, "yes", null);
  addAsk.run("t2", "Go-live sign-off", "", "2026-10-05", "accepted", "Go-Live", "high", 3, "yes", null);
  addAsk.run("t3", "#7040 ADO bug", "", null, "open", null, null, null, null, "ado:Org/Proj#7040");
  db.prepare("INSERT INTO relay_ask_dependencies (id, ask_id, depends_on_ask_id, source, created_at) VALUES ('d1','t2','t1','import',?)").run(now);
  db.prepare(`INSERT INTO relay_ado_links (project_id, org, ado_project, work_item_types, exclude_states, auto_mirror, updated_at)
              VALUES ('b2b','Kafkas-eCommerce','Edison-B2B','Bug','Closed,Done,Removed',1,?)`).run(now);
  return { db, env: { DB: createD1(db) } };
}

const create = (env, body) => worker.fetch(new Request(ORIGIN + "/api/projects", {
  method: "POST", headers: { host: "127.0.0.1:8787", origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
}), env);

test("new rollout from template copies structure, not progress", async () => {
  const { db, env } = setup();
  const res = await create(env, { name: "B2C GR", template_project_id: "b2b", copy: { tasks: true, board: true, members: true } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual([data.copied.tasks, data.copied.dependencies, data.copied.board_columns, data.copied.members], [2, 1, 1, 1]);

  const tasks = db.prepare("SELECT * FROM asks WHERE project_id = ? ORDER BY title").all(data.id);
  assert.deepEqual(tasks.map((t) => t.title), ["Go-live sign-off", "Smoke test παραγωγής"], "ADO-mirrored task not copied");
  for (const t of tasks) {
    assert.equal(t.owner, "");
    assert.equal(t.status, "open");
    assert.equal(t.due_date, null);
    assert.equal(t.external_import_key, null);
  }
  assert.equal(tasks[1].priority, "critical");
  assert.equal(tasks[1].story_points, 5);
  assert.equal(tasks[1].section, "UAT");
  const dep = db.prepare("SELECT ask_id, depends_on_ask_id FROM relay_ask_dependencies WHERE ask_id = ?").get(tasks[0].id);
  assert.equal(dep.depends_on_ask_id, tasks[1].id, "dependency points inside the new project");
  assert.equal(db.prepare("SELECT invite_status FROM relay_project_members WHERE project_id = ?").get(data.id).invite_status, "failed",
    "invite attempted (email not configured in tests)");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM relay_ado_links WHERE project_id = ?").get(data.id).c, 0, "no ADO link without area/query");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM asks WHERE project_id = 'b2b'").get().c, 3, "template untouched");
});

test("ADO link is created only with an area path or query, using the template's org/project", async () => {
  const { db, env } = setup();
  const data = await (await create(env, { name: "B2B CY", template_project_id: "b2b", ado: { area_path: "Edison-B2B\\B2B CY" } })).json();
  const link = db.prepare("SELECT * FROM relay_ado_links WHERE project_id = ?").get(data.id);
  assert.deepEqual([link.org, link.ado_project, link.area_path, link.auto_mirror], ["Kafkas-eCommerce", "Edison-B2B", "Edison-B2B\\B2B CY", 1]);

  const bad = await create(env, { name: "X", template_project_id: "b2b", ado: { area_path: "x' OR 1=1" } });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM projects WHERE name = 'X'").get().c, 0, "nothing created on invalid ADO input");
});

test("unknown template is refused; plain project creation still works", async () => {
  const { env } = setup();
  assert.equal((await create(env, { name: "Y", template_project_id: "nope" })).status, 404);
  const plain = await create(env, { name: "Plain" });
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).copied, undefined);
});
