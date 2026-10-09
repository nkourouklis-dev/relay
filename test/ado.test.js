import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { normalizeWorkItem, parseLinkInput } from "../src/ado.js";

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
const DEV_USER = "local-development-user"; // ο dev actor σε localhost (admin)
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function setup({ pat = "test-pat" } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  db.exec("DELETE FROM events; DELETE FROM asks;");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO relay_users (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, 'Dev', 'dev@local.relay', 1, ?, ?, 'admin')").run(DEV_USER, now, now);
  db.prepare("INSERT INTO projects (id, name, inbox_alias, created_by_user_id) VALUES ('p1', 'Go-Live', 'golive', ?)").run(DEV_USER);
  db.prepare("INSERT INTO relay_project_members (id, project_id, email, invited_at) VALUES ('m1','p1','ekareliotis@kafkas.gr',?)").run(now);
  const env = { DB: createD1(db), ADO_BASE_URL: "https://ado.test" };
  if (pat) env.ADO_PAT = pat;
  return { db, env };
}

const WORK_ITEMS = [
  { id: 7040, fields: { "System.WorkItemType": "Bug", "System.Title": "Limit στο cart", "System.State": "Active",
    "Microsoft.VSTS.Common.Severity": "2 - High", "Microsoft.VSTS.Common.Priority": 2,
    "System.AssignedTo": { displayName: "Evangelos Kareliotis", uniqueName: "EKareliotis@kafkas.gr" },
    "System.CreatedDate": "2026-09-27T10:00:00Z", "System.ChangedDate": "2026-10-08T10:00:00Z" } },
  { id: 7002, fields: { "System.WorkItemType": "Bug", "System.Title": "Defect σε PROD", "System.State": "New",
    "Microsoft.VSTS.Common.Severity": "1 - Critical",
    "System.AssignedTo": { displayName: "Vendor Person", uniqueName: "a.vendor@netcompany.com" } } },
];

// Ψεύτικο ADO: ελέγχει το Basic auth και επιστρέφει WIQL + workitemsbatch.
function mockAdo({ status } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (status === 203) return new Response("<html>Sign in</html>", { status: 203, headers: { "content-type": "text/html" } });
    if (status) return new Response("{}", { status, headers: { "content-type": "application/json" } });
    assert.equal(init.headers.Authorization, `Basic ${btoa(":test-pat")}`);
    if (String(url).includes("/_apis/wit/wiql")) {
      return Response.json({ workItems: WORK_ITEMS.map((w) => ({ id: w.id })) });
    }
    if (String(url).includes("/_apis/wit/workitemsbatch")) {
      const ids = JSON.parse(init.body).ids;
      return Response.json({ value: WORK_ITEMS.filter((w) => ids.includes(w.id)) });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function call(env, method, path, body) {
  const headers = { host: "127.0.0.1:8787", origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
}

const link = (env) => call(env, "PUT", "/api/projects/p1/ado", { org: "Kafkas-eCommerce", ado_project: "Edison-B2B" });

test("parseLinkInput validates org, project, query id and lists", () => {
  assert.deepEqual(parseLinkInput({ org: "Kafkas-eCommerce", ado_project: "Edison-B2B" }), {
    org: "Kafkas-eCommerce", ado_project: "Edison-B2B", query_id: null, work_item_types: "Bug", exclude_states: "Closed,Done,Removed",
  });
  assert.ok(parseLinkInput({ org: "bad/org", ado_project: "x" }).error);
  assert.ok(parseLinkInput({ org: "o", ado_project: "a/b" }).error);
  assert.ok(parseLinkInput({ org: "o", ado_project: "p", query_id: "not-a-guid" }).error);
  assert.ok(parseLinkInput({ org: "o", ado_project: "p", work_item_types: "Bug') OR 1=1 --" }).error);
});

test("normalizeWorkItem extracts the assignee email only from uniqueName", () => {
  const item = normalizeWorkItem(WORK_ITEMS[0]);
  assert.equal(item.assigned_email, "ekareliotis@kafkas.gr");
  assert.equal(item.severity, "2 - High");
  assert.equal(normalizeWorkItem({ id: 1, fields: { "System.AssignedTo": { displayName: "Γιώργος" } } }).assigned_email, "");
});

test("config reports a missing token and never exposes it", async () => {
  const { env } = setup({ pat: "" });
  const data = await (await call(env, "GET", "/api/projects/p1/ado")).json();
  assert.equal(data.token_configured, false);
  assert.equal(data.link, null);

  const withPat = setup();
  const text = await (await call(withPat.env, "GET", "/api/projects/p1/ado")).text();
  assert.doesNotMatch(text, /test-pat/);
});

test("items are fetched live, cached, and show which already became asks", async () => {
  const { env } = setup();
  const ado = mockAdo();
  try {
    assert.equal((await link(env)).status, 200);
    const first = await (await call(env, "GET", "/api/projects/p1/ado/items")).json();
    assert.equal(first.items.length, 2);
    assert.equal(first.cached, false);
    assert.equal(first.items[0].url, "https://ado.test/Kafkas-eCommerce/Edison-B2B/_workitems/edit/7040");
    assert.match(JSON.parse(ado.calls[0].body).query, /\[System\.WorkItemType\] IN \('Bug'\)/);

    const before = ado.calls.length;
    const second = await (await call(env, "GET", "/api/projects/p1/ado/items")).json();
    assert.equal(second.cached, true);
    assert.equal(ado.calls.length, before, "served from cache");
  } finally {
    ado.restore();
  }
});

test("invalid token is reported clearly; last known data is kept as stale", async () => {
  const { env } = setup();
  let ado = mockAdo({ status: 203 });
  try {
    await link(env);
    const res = await call(env, "GET", "/api/projects/p1/ado/items");
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "auth_failed");
  } finally { ado.restore(); }

  ado = mockAdo();
  try { await call(env, "GET", "/api/projects/p1/ado/items?refresh=1"); } finally { ado.restore(); }
  ado = mockAdo({ status: 500 });
  try {
    const data = await (await call(env, "GET", "/api/projects/p1/ado/items?refresh=1")).json();
    assert.equal(data.stale, true);
    assert.equal(data.items.length, 2);
  } finally { ado.restore(); }
});

test("→ Ενέργεια creates one ask, maps owner only for exact member emails", async () => {
  const { db, env } = setup();
  const ado = mockAdo();
  try {
    await link(env);
    const made = await (await call(env, "POST", "/api/projects/p1/ado/items/7040/ask")).json();
    assert.equal(made.ok, true);
    assert.equal(made.owner, "ekareliotis@kafkas.gr");
    const ask = db.prepare("SELECT title, owner, ado_url, source_quote FROM asks WHERE id = ?").get(made.id);
    assert.equal(ask.title, "#7040 Limit στο cart");
    assert.equal(ask.ado_url, "https://ado.test/Kafkas-eCommerce/Edison-B2B/_workitems/edit/7040");
    assert.match(ask.source_quote, /ADO Bug #7040/);

    const again = await (await call(env, "POST", "/api/projects/p1/ado/items/7040/ask")).json();
    assert.equal(again.existed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM asks").get().c, 1);

    const vendor = await (await call(env, "POST", "/api/projects/p1/ado/items/7002/ask")).json();
    assert.equal(vendor.owner, "", "non-member assignee is not mapped");

    const listed = await (await call(env, "GET", "/api/projects/p1/ado/items")).json();
    assert.ok(listed.items.every((i) => i.ask_id));

    assert.equal((await call(env, "POST", "/api/projects/p1/ado/items/9999/ask")).status, 404);
    assert.equal((await call(env, "POST", "/api/projects/p1/ado/items/abc/ask")).status, 400);
  } finally {
    ado.restore();
  }
});

test("unlinked project and unknown project are refused", async () => {
  const { env } = setup();
  assert.equal((await call(env, "GET", "/api/projects/p1/ado/items")).status, 409);
  assert.equal((await call(env, "GET", "/api/projects/nope/ado")).status, 404);
});
