import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import {
  athensClock, dispatchDailyDigests, dueLabel, signActionToken, verifyActionToken,
} from "../src/daily-digest.js";

// Ίδιος ελάχιστος D1 adapter με το mcp-draft-routes.test.js.
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

const SECRET = "test-secret";
const APP = "https://relay.test";
// Τρίτη 2026-10-13, 07:30 ώρα Αθήνας (UTC+3).
const TUESDAY_MORNING = new Date("2026-10-13T04:30:00Z");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  db.exec("DELETE FROM events; DELETE FROM asks;");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO relay_users (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1','Owner','owner@kafkas.gr',1,?,?,'user')").run(now, now);
  db.prepare("INSERT INTO projects (id, name, inbox_alias, created_by_user_id) VALUES ('p1', 'Go-Live', 'golive', 'u1')").run();
  db.prepare("INSERT INTO relay_project_members (id, project_id, email, invited_at) VALUES ('m1','p1','maria@kafkas.gr',?)").run(now);
  const addAsk = db.prepare("INSERT INTO asks (id, project_id, title, owner, due_date, status) VALUES (?, 'p1', ?, ?, ?, ?)");
  addAsk.run("late", "Στείλε το BRD", "maria@kafkas.gr", "2026-10-10", "open");
  addAsk.run("today", "Review test plan", "Maria@Kafkas.gr", "2026-10-13", "accepted");
  addAsk.run("later", "Μακρινό", "maria@kafkas.gr", "2026-10-30", "open");
  addAsk.run("closed", "Κλειστό", "maria@kafkas.gr", "2026-10-12", "done");
  addAsk.run("free", "Ελεύθερη εργασία", "", "2026-10-14", "open");
  addAsk.run("legacy", "Παλιό", "Γιώργος", "2026-10-01", "open");
  addAsk.run("outsider", "Εξωτερικό", "someone@gmail.com", "2026-10-12", "open");
  const env = { DB: createD1(db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: APP };
  return { db, env };
}

function deps(sent) {
  return {
    sendEmail: async (_env, msg) => { sent.push(msg); return { ok: true }; },
    isAllowed: async (_env, email) => email.endsWith("@kafkas.gr"),
  };
}

const tokenFrom = (url) => new URL(url).searchParams.get("t");
const linkIn = (msg, label) => {
  const match = msg.text.match(new RegExp(`${label}: (\\S+)`));
  return match && match[1];
};
const post = (env, token) => {
  const body = new URLSearchParams({ t: token });
  return worker.fetch(new Request(`${APP}/api/email-action`, { method: "POST", body, headers: { host: "relay.test" } }), env);
};
const get = (env, token) =>
  worker.fetch(new Request(`${APP}/api/email-action?t=${encodeURIComponent(token)}`, { headers: { host: "relay.test" } }), env);

test("athensClock and dueLabel use Athens local dates", () => {
  assert.deepEqual(athensClock(TUESDAY_MORNING), { date: "2026-10-13", hour: 7, weekday: "Tue" });
  assert.equal(dueLabel("2026-10-10", "2026-10-13"), "Εκπρόθεσμη από Σάβ 10/10");
  assert.equal(dueLabel("2026-10-13", "2026-10-13"), "Λήγει σήμερα");
  assert.equal(dueLabel("2026-10-14", "2026-10-13"), "Λήγει αύριο");
});

test("tokens: valid, tampered, wrong secret, expired", async () => {
  const now = Date.now();
  const token = await signActionToken(SECRET, { action: "done", email: "A@kafkas.gr", askId: "x", ttlSeconds: 60, now });
  assert.deepEqual(await verifyActionToken(SECRET, token, now), { action: "done", email: "a@kafkas.gr", askId: "x" });
  const [v, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ x: "done", e: "a@kafkas.gr", a: "y", exp: 9e9 })).toString("base64url");
  assert.equal((await verifyActionToken(SECRET, `${v}.${forged}.${sig}`, now)).error, "invalid");
  assert.equal((await verifyActionToken("other", token, now)).error, "invalid");
  assert.equal((await verifyActionToken(SECRET, token, now + 61_000)).error, "expired");
  assert.equal((await verifyActionToken(SECRET, `${v}.${payload}`, now)).error, "invalid");
});

test("digest is sent only on weekday mornings", async () => {
  const { env } = setup();
  const sent = [];
  assert.equal((await dispatchDailyDigests(env, new Date("2026-10-13T03:30:00Z"), deps(sent))).skipped, "window"); // 06:30
  assert.equal((await dispatchDailyDigests(env, new Date("2026-10-13T09:00:00Z"), deps(sent))).skipped, "window"); // 12:00
  assert.equal((await dispatchDailyDigests(env, new Date("2026-10-17T05:00:00Z"), deps(sent))).skipped, "window"); // Σάββατο
  assert.equal(sent.length, 0);
});

test("one email per person per day, with only their due/overdue asks plus free asks", async () => {
  const { env } = setup();
  const sent = [];
  await dispatchDailyDigests(env, TUESDAY_MORNING, deps(sent));
  assert.equal(sent.length, 1, "only maria (owner@ has nothing due; gmail not allowed; free-text legacy owner skipped)");
  const msg = sent[0];
  assert.deepEqual(msg.to, ["maria@kafkas.gr"]);
  assert.match(msg.subject, /1 εκπρόθεσμη, 1 για σήμερα/);
  assert.match(msg.text, /Στείλε το BRD/);
  assert.match(msg.text, /Review test plan/);
  assert.doesNotMatch(msg.text, /Μακρινό|Κλειστό|Παλιό|Εξωτερικό/);
  assert.match(msg.text, /Ελεύθερη εργασία[\s\S]*Ανάληψη: /);
  assert.match(msg.html, /✔ Έγινε/);

  await dispatchDailyDigests(env, new Date("2026-10-13T05:15:00Z"), deps(sent));
  assert.equal(sent.length, 1, "no second email the same day");
});

test("failed send is retried on the next run", async () => {
  const { env } = setup();
  let attempts = 0;
  const failing = { ...deps([]), sendEmail: async () => { attempts++; return { ok: false }; } };
  await dispatchDailyDigests(env, TUESDAY_MORNING, failing);
  const sent = [];
  await dispatchDailyDigests(env, new Date("2026-10-13T04:45:00Z"), deps(sent));
  assert.equal(attempts, 1);
  assert.equal(sent.length, 1);
});

test("GET only confirms; POST marks the ask done", async () => {
  const { db, env } = setup();
  const sent = [];
  await dispatchDailyDigests(env, TUESDAY_MORNING, deps(sent));
  const token = tokenFrom(linkIn(sent[0], "Έγινε"));

  const page = await get(env, token);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post"/);
  assert.equal(db.prepare("SELECT status FROM asks WHERE id = 'late'").get().status, "open", "GET must not change anything");

  const done = await post(env, token);
  assert.equal(done.status, 200);
  assert.equal(db.prepare("SELECT status FROM asks WHERE id = 'late'").get().status, "done");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events WHERE ask_id = 'late' AND type = 'done'").get().c, 1);
  assert.equal((await post(env, token)).status, 200, "repeat click is harmless");
});

test("snooze moves an overdue ask to tomorrow; refused once reassigned", async () => {
  const { db, env } = setup();
  const now = Date.now();
  const token = await signActionToken(SECRET, { action: "snooze", email: "maria@kafkas.gr", askId: "late", ttlSeconds: 600, now });
  assert.equal((await post(env, token)).status, 200);
  const due = db.prepare("SELECT due_date FROM asks WHERE id = 'late'").get().due_date;
  assert.ok(due > "2026-10-10");

  db.prepare("UPDATE asks SET owner = 'owner@kafkas.gr' WHERE id = 'late'").run();
  const refused = await post(env, token);
  assert.equal(refused.status, 409);
  assert.equal(db.prepare("SELECT due_date FROM asks WHERE id = 'late'").get().due_date, due);
});

test("claim works for project members only and only while unassigned", async () => {
  const { db, env } = setup();
  const now = Date.now();
  const outsider = await signActionToken(SECRET, { action: "claim", email: "x@kafkas.gr", askId: "free", ttlSeconds: 600, now });
  assert.equal((await post(env, outsider)).status, 409);

  const maria = await signActionToken(SECRET, { action: "claim", email: "maria@kafkas.gr", askId: "free", ttlSeconds: 600, now });
  assert.equal((await post(env, maria)).status, 200);
  assert.equal(db.prepare("SELECT owner FROM asks WHERE id = 'free'").get().owner, "maria@kafkas.gr");

  const creator = await signActionToken(SECRET, { action: "claim", email: "owner@kafkas.gr", askId: "free", ttlSeconds: 600, now });
  assert.equal((await post(env, creator)).status, 409, "already claimed");
});

test("unsubscribe stops tomorrow's digest", async () => {
  const { db, env } = setup();
  const sent = [];
  await dispatchDailyDigests(env, TUESDAY_MORNING, deps(sent));
  const match = sent[0].text.match(/Δεν θέλεις αυτό το email; (\S+)/);
  assert.equal((await post(env, tokenFrom(match[1]))).status, 200);
  assert.equal(db.prepare("SELECT daily_digest FROM relay_email_prefs WHERE email = 'maria@kafkas.gr'").get().daily_digest, 0);

  await dispatchDailyDigests(env, new Date("2026-10-14T04:30:00Z"), deps(sent));
  assert.equal(sent.length, 1);
});

test("bad or missing token never touches data", async () => {
  const { db, env } = setup();
  assert.equal((await get(env, "nope")).status, 400);
  assert.equal((await post(env, "v1.abc.def")).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 0);
});
