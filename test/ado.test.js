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
    area_path: null, auto_mirror: 1,
  });
  assert.equal(parseLinkInput({ org: "o", ado_project: "p", area_path: "Edison-B2B\\B2C GR" }).area_path, "Edison-B2B\\B2C GR");
  assert.ok(parseLinkInput({ org: "o", ado_project: "p", area_path: "x' OR 1=1" }).error);
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

// ---------- Καθρέφτης ADO → Ενέργειες ----------
import { dispatchAdoMirrors, statusFromState } from "../src/ado.js";
import { dispatchDailyDigests } from "../src/daily-digest.js";

function mirrorMock(items) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    if (String(url).includes("/_apis/wit/wiql")) return Response.json({ workItems: items.filter((w) => !w.hidden).map((w) => ({ id: w.id })) });
    if (String(url).includes("/_apis/wit/workitemsbatch")) {
      const ids = JSON.parse(init.body).ids;
      return Response.json({ value: items.filter((w) => ids.includes(w.id) && !w.deleted) });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const wi = (id, fields, extra = {}) => ({ id, fields: { "System.WorkItemType": "Bug", ...fields }, ...extra });

test("statusFromState maps ADO states to Relay statuses", () => {
  assert.equal(statusFromState("New"), "open");
  assert.equal(statusFromState("Active"), "accepted");
  assert.equal(statusFromState("Resolved"), "accepted");
  assert.equal(statusFromState("Closed"), "done");
  assert.equal(statusFromState("Parked", "Closed,Parked"), "done");
});

test("mirror creates asks from ADO, follows changes, closes deleted, skips already-closed", async () => {
  const { db, env } = setup();
  const sent = [];
  env.RESEND_API_KEY = "x"; env.AUTH_EMAIL_FROM = "Relay <r@test>";
  const items = [
    wi(1, { "System.Title": "Cart limit", "System.State": "Active", "Microsoft.VSTS.Common.Severity": "1 - Critical",
      "System.AssignedTo": { displayName: "E K", uniqueName: "ekareliotis@kafkas.gr" }, "Microsoft.VSTS.Scheduling.DueDate": "2026-10-20T00:00:00Z" }),
    wi(2, { "System.Title": "Vendor bug", "System.State": "New", "System.AssignedTo": { displayName: "Vendor", uniqueName: "v@netcompany.com" } }),
    wi(3, { "System.Title": "Old closed", "System.State": "Closed" }),
  ];
  let ado = mirrorMock(items);
  try {
    await link(env);
    const r = await dispatchAdoMirrors(env);
    assert.equal(r.projects[0].created, 2);
  } finally { ado.restore(); }
  const one = db.prepare("SELECT * FROM asks WHERE external_import_key LIKE '%#1'").get();
  assert.deepEqual([one.title, one.status, one.owner, one.priority, one.due_date, one.assignees], ["#1 Cart limit", "accepted", "ekareliotis@kafkas.gr", "critical", "2026-10-20", "E K"]);
  const two = db.prepare("SELECT * FROM asks WHERE external_import_key LIKE '%#2'").get();
  assert.deepEqual([two.status, two.owner, two.assignees], ["open", "", "Vendor"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM asks WHERE external_import_key LIKE '%#3'").get().c, 0);

  // 2ος γύρος: τίποτα δεν άλλαξε → καμία αλλαγή.
  ado = mirrorMock(items);
  try { assert.equal((await dispatchAdoMirrors(env)).projects[0].updated, 0); } finally { ado.restore(); }

  // Το #1 κλείνει, το #2 σβήνεται στο ADO.
  items[0].fields["System.State"] = "Closed";
  items[1].hidden = true; items[1].deleted = true;
  ado = mirrorMock(items);
  try { await dispatchAdoMirrors(env); } finally { ado.restore(); }
  assert.equal(db.prepare("SELECT status FROM asks WHERE id = ?").get(one.id).status, "done");
  assert.equal(db.prepare("SELECT status FROM asks WHERE id = ?").get(two.id).status, "done");
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM events WHERE ask_id = ? AND type = 'done'").get(two.id).c >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM asks").get().c, 2, "nothing deleted");
});

test("ADO-mirrored asks are locked in Relay except story points / sprint", async () => {
  const { db, env } = setup();
  const ado = mirrorMock([wi(5, { "System.Title": "Locked", "System.State": "New" })]);
  try { await link(env); await dispatchAdoMirrors(env); } finally { ado.restore(); }
  const id = db.prepare("SELECT id FROM asks").get().id;

  const listed = await (await call(env, "GET", "/api/asks?project_id=p1")).json();
  assert.equal(listed[0].ado_managed, true);

  for (const [method, path, body] of [
    ["POST", `/api/asks/${id}/quick`, { status: "done" }],
    ["POST", `/api/asks/${id}/status`, { status: "done" }],
    ["POST", `/api/asks/${id}/claim`, {}],
    ["DELETE", `/api/asks/${id}`],
    ["PUT", `/api/asks/${id}`, { title: "changed", owner: "", status: "open" }],
  ]) {
    const res = await call(env, method, path, body);
    assert.equal(res.status, 409, `${method} ${path}`);
  }
  assert.equal((await call(env, "POST", `/api/asks/${id}/quick`, { story_points: 5 })).status, 200);
  assert.equal((await call(env, "PUT", `/api/asks/${id}`, { title: "#5 Locked", owner: "", status: "open", due_date: null, story_points: 8 })).status, 200);
  assert.equal(db.prepare("SELECT story_points, status FROM asks WHERE id = ?").get(id).story_points, 8);

  // Αποσύνδεση: η ενέργεια μένει και ξεκλειδώνει.
  await call(env, "DELETE", "/api/projects/p1/ado");
  assert.equal((await call(env, "POST", `/api/asks/${id}/quick`, { status: "done" })).status, 200);
});

test("morning email links ADO asks to ADO instead of one-click buttons", async () => {
  const { db, env } = setup();
  env.BETTER_AUTH_SECRET = "s"; env.BETTER_AUTH_URL = "https://relay.test";
  const ado = mirrorMock([wi(9, { "System.Title": "Due bug", "System.State": "Active",
    "System.AssignedTo": { displayName: "E", uniqueName: "ekareliotis@kafkas.gr" }, "Microsoft.VSTS.Scheduling.DueDate": "2026-10-13T00:00:00Z" })]);
  try { await link(env); await dispatchAdoMirrors(env); } finally { ado.restore(); }
  const sent = [];
  await dispatchDailyDigests(env, new Date("2026-10-13T04:30:00Z"), {
    sendEmail: async (_e, m) => { sent.push(m); return { ok: true }; }, isAllowed: async () => true,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /Άνοιγμα στο ADO/);
  assert.doesNotMatch(sent[0].html, /✔ Έγινε/);
  assert.match(sent[0].text, /ADO: https:\/\/ado\.test\/Kafkas-eCommerce\/Edison-B2B\/_workitems\/edit\/9/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM relay_daily_digests").get().c, 1);
});
