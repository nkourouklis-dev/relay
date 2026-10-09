// Relay — προσωπικό πρωινό email «Τα δικά σου σήμερα» + κουμπιά ενός κλικ.
//
// - Ένα email ανά άνθρωπο, εργάσιμες, από τις 07:00 ώρα Αθήνας, μόνο αν έχει κάτι (εκπρόθεσμο ή λήγει σε ≤2 ημέρες).
// - Κουμπιά: Έγινε · Αύριο (μετάθεση) · Ανάληψη (για ελεύθερες ενέργειες των projects του).
// - Κάθε κουμπί είναι υπογεγραμμένο (HMAC με BETTER_AUTH_SECRET), δεμένο σε ask + email + ενέργεια, λήγει.
// - Το GET δείχνει ΜΟΝΟ σελίδα επιβεβαίωσης· η αλλαγή γίνεται με POST. Έτσι οι σαρωτές συνδέσμων
//   (π.χ. Microsoft Safe Links) που ανοίγουν τα links δεν αλλάζουν τίποτα.
// - Όλες οι ενέργειες είναι idempotent, οπότε δεν χρειάζεται πίνακας «χρησιμοποιημένων» tokens.

import { ADO_LOCKED_MESSAGE, adoLockedAsk } from "./ado.js";

const TOKEN_VERSION = "v1";
const ASK_ACTION_TTL_SECONDS = 3 * 24 * 3600;
const PREF_ACTION_TTL_SECONDS = 90 * 24 * 3600;
const ASK_ACTIONS = ["done", "snooze", "claim"];
const PREF_ACTIONS = ["unsub", "resub"];
const DIGEST_FIRST_HOUR = 7;   // ώρα Αθήνας
const DIGEST_LAST_HOUR = 11;   // μετά από αυτή δεν στέλνουμε «πρωινό» email
const DUE_WINDOW_DAYS = 2;     // σήμερα + 2 ημέρες
const MAX_OWN_ITEMS = 10;
const MAX_FREE_ITEMS = 3;
const FREE_WINDOW_DAYS = 7;
export const EMAIL_ACTION_PATH = "/api/email-action";

// ---------- Ημερομηνίες (Europe/Athens) ----------
export function athensClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday };
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const GREEK_WEEKDAYS = ["Κυρ", "Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ"];
function shortDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = GREEK_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d}/${m}`;
}

export function dueLabel(dueDate, today) {
  if (!dueDate) return "Χωρίς προθεσμία";
  if (dueDate < today) return `Εκπρόθεσμη από ${shortDate(dueDate)}`;
  if (dueDate === today) return "Λήγει σήμερα";
  if (dueDate === addDays(today, 1)) return "Λήγει αύριο";
  return `Λήγει ${shortDate(dueDate)}`;
}

// ---------- Tokens ----------
const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value) {
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(`relay-email-action:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signActionToken(secret, { action, email, askId = "", ttlSeconds, now = Date.now() }) {
  const payload = b64url(enc.encode(JSON.stringify({
    x: action, e: String(email).toLowerCase(), a: askId, exp: Math.floor(now / 1000) + ttlSeconds,
  })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${TOKEN_VERSION}.${payload}`));
  return `${TOKEN_VERSION}.${payload}.${b64url(new Uint8Array(signature))}`;
}

// Επιστρέφει { action, email, askId } ή { error }.
export async function verifyActionToken(secret, token, now = Date.now()) {
  if (!secret) return { error: "not_configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || parts[1].length > 2000) return { error: "invalid" };
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return { error: "invalid" };
    const data = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (![...ASK_ACTIONS, ...PREF_ACTIONS].includes(data.x) || !data.e) return { error: "invalid" };
    if (ASK_ACTIONS.includes(data.x) && !data.a) return { error: "invalid" };
    if (!Number.isFinite(data.exp) || data.exp * 1000 < now) return { error: "expired" };
    return { action: data.x, email: data.e, askId: data.a || "" };
  } catch {
    return { error: "invalid" };
  }
}

// ---------- HTML helpers ----------
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

const COLORS = { ink: "#1f2937", muted: "#6b7280", line: "#e5e7eb", brand: "#0b4f8a", danger: "#b42318", ok: "#067647", bg: "#f6f7f9" };

function button(href, label, color = COLORS.brand) {
  return `<a href="${esc(href)}" style="display:inline-block;margin:4px 6px 0 0;padding:8px 14px;border-radius:8px;` +
    `background:${color};color:#fff;text-decoration:none;font-weight:600;font-size:14px">${esc(label)}</a>`;
}

// ---------- Περιεχόμενο email ----------
// own/free: [{ id, title, due_date, project_name, project_id }], links: { [askId]: { done, snooze, claim } }
export function buildDigestEmail({ email, today, own, free, links, appUrl, unsubscribeUrl }) {
  const overdue = own.filter((a) => a.due_date < today).length;
  const dueToday = own.filter((a) => a.due_date === today).length;
  const subjectParts = [];
  if (overdue) subjectParts.push(`${overdue} εκπρόθεσμ${overdue === 1 ? "η" : "ες"}`);
  if (dueToday) subjectParts.push(`${dueToday} για σήμερα`);
  const upcoming = own.length - overdue - dueToday;
  if (upcoming) subjectParts.push(`${upcoming} τις επόμενες μέρες`);
  const subject = `Relay — Τα δικά σου σήμερα: ${subjectParts.join(", ")}`;

  const textLine = (a) => `• ${a.title} — ${dueLabel(a.due_date, today)} · ${a.project_name}`;
  const text =
    `Καλημέρα! Αυτά είναι στο όνομά σου:\n\n` +
    own.map((a) => links[a.id].ado
      ? `${textLine(a)}\n  ADO: ${links[a.id].ado}`
      : `${textLine(a)}\n  Έγινε: ${links[a.id].done}\n  Αύριο: ${links[a.id].snooze}`).join("\n") +
    (free.length
      ? `\n\nΕλεύθερες ενέργειες στα projects σου:\n` +
        free.map((a) => `${textLine(a)}\n  ${links[a.id].ado ? `ADO: ${links[a.id].ado}` : `Ανάληψη: ${links[a.id].claim}`}`).join("\n")
      : "") +
    `\n\nΆνοιξε το Relay: ${appUrl}\n\nΔεν θέλεις αυτό το email; ${unsubscribeUrl}`;

  const card = (a, buttons) => {
    const late = a.due_date && a.due_date < today;
    return `<tr><td style="padding:12px 0;border-top:1px solid ${COLORS.line}">` +
      `<div style="font-size:15px;font-weight:600;color:${COLORS.ink}">${esc(a.title)}</div>` +
      `<div style="font-size:13px;color:${late ? COLORS.danger : COLORS.muted};margin-top:2px">` +
      `${esc(dueLabel(a.due_date, today))} · ${esc(a.project_name)}</div>` +
      `<div style="margin-top:6px">${buttons}</div></td></tr>`;
  };
  const adoButton = (a) => button(links[a.id].ado, "Άνοιγμα στο ADO ↗");
  const ownRows = own.map((a) => card(a, links[a.id].ado ? adoButton(a) :
    button(links[a.id].done, "✔ Έγινε", COLORS.ok) +
    button(links[a.id].snooze, a.due_date <= today ? "⏭ Αύριο" : "⏭ +1 ημέρα", COLORS.muted)
  )).join("");
  const freeRows = free.map((a) => card(a, links[a.id].ado ? adoButton(a) : button(links[a.id].claim, "🙋 Ανάληψη"))).join("");

  const html =
    `<div style="background:${COLORS.bg};padding:24px 12px;font-family:Segoe UI,Arial,sans-serif">` +
    `<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:20px 24px">` +
    `<tr><td><div style="font-size:20px;font-weight:700;color:${COLORS.ink}">Καλημέρα 👋</div>` +
    `<div style="font-size:14px;color:${COLORS.muted};margin:4px 0 8px">Αυτά είναι στο όνομά σου. Ένα κλικ και τελείωσες.</div></td></tr>` +
    ownRows +
    (freeRows
      ? `<tr><td style="padding-top:18px;font-size:14px;font-weight:700;color:${COLORS.ink}">Ελεύθερες ενέργειες στα projects σου</td></tr>` + freeRows
      : "") +
    `<tr><td style="padding-top:18px">${button(appUrl, "Άνοιξε το Relay")}</td></tr>` +
    `<tr><td style="padding-top:18px;font-size:12px;color:${COLORS.muted}">Σου στέλνουμε αυτό το email μόνο τις εργάσιμες που έχεις κάτι να κλείσεις. ` +
    `<a href="${esc(unsubscribeUrl)}" style="color:${COLORS.muted}">Διακοπή</a></td></tr>` +
    `</table></div>`;

  return { to: [email], subject, text, html };
}

// ---------- Αποστολή (cron) ----------
// Ενέργειες από ADO: τα κουμπιά ανοίγουν το work item στο ADO (εκεί αλλάζει η κατάσταση).
const ADO_FLAG_SQL = `a.ado_url,
  CASE WHEN a.external_import_key LIKE 'ado:%' AND EXISTS (
    SELECT 1 FROM relay_ado_links l WHERE l.project_id = a.project_id AND l.auto_mirror = 1
  ) THEN 1 ELSE 0 END AS ado_managed`;
// deps: { sendEmail(env, msg) -> { ok }, isAllowed(env, email) -> bool }
export async function dispatchDailyDigests(env, now = new Date(), deps) {
  const clock = athensClock(now);
  if (["Sat", "Sun"].includes(clock.weekday) || clock.hour < DIGEST_FIRST_HOUR || clock.hour >= DIGEST_LAST_HOUR) {
    return { skipped: "window", sent: 0 };
  }
  if (!env.BETTER_AUTH_SECRET) return { skipped: "not_configured", sent: 0 };

  const today = clock.date;
  const appUrl = env.BETTER_AUTH_URL || "";
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.due_date, lower(trim(a.owner)) AS owner_email, a.project_id, p.name AS project_name,
            ${ADO_FLAG_SQL}
     FROM asks a JOIN projects p ON p.id = a.project_id
     WHERE COALESCE(a.status, 'open') != 'done'
       AND a.owner LIKE '%@%'
       AND a.due_date IS NOT NULL AND a.due_date != '' AND a.due_date <= ?
       AND NOT EXISTS (SELECT 1 FROM relay_daily_digests d WHERE d.email = lower(trim(a.owner)) AND d.digest_date = ?)
       AND NOT EXISTS (SELECT 1 FROM relay_email_prefs f WHERE f.email = lower(trim(a.owner)) AND f.daily_digest = 0)
     ORDER BY a.due_date, a.created_at
     LIMIT 3000`
  ).bind(addDays(today, DUE_WINDOW_DAYS), today).all();

  const byEmail = new Map();
  for (const row of results || []) {
    if (!byEmail.has(row.owner_email)) byEmail.set(row.owner_email, []);
    byEmail.get(row.owner_email).push(row);
  }

  let sent = 0;
  for (const [email, rows] of byEmail) {
    if (!(await deps.isAllowed(env, email))) continue;

    // Κλείδωμα της ημέρας πριν την αποστολή (ώστε δύο εκτελέσεις cron να μη στείλουν διπλό).
    const lock = await env.DB.prepare(
      "INSERT OR IGNORE INTO relay_daily_digests (email, digest_date, sent_at, item_count) VALUES (?, ?, ?, ?)"
    ).bind(email, today, now.toISOString(), 0).run();
    if (!lock.meta?.changes) continue;

    const own = rows.slice(0, MAX_OWN_ITEMS);
    const { results: freeRows } = await env.DB.prepare(
      `SELECT a.id, a.title, a.due_date, a.project_id, p.name AS project_name, ${ADO_FLAG_SQL}
       FROM asks a JOIN projects p ON p.id = a.project_id
       WHERE COALESCE(a.status, 'open') != 'done'
         AND (a.owner IS NULL OR trim(a.owner) = '')
         AND a.due_date IS NOT NULL AND a.due_date != '' AND a.due_date <= ?
         AND (p.id IN (SELECT project_id FROM relay_project_members WHERE email = ?)
              OR p.created_by_user_id IN (SELECT id FROM relay_users WHERE lower(email) = ?))
       ORDER BY a.due_date
       LIMIT ?`
    ).bind(addDays(today, FREE_WINDOW_DAYS), email, email, MAX_FREE_ITEMS).all();
    const free = freeRows || [];

    const links = {};
    const link = async (action, askId) =>
      `${appUrl}${EMAIL_ACTION_PATH}?t=${await signActionToken(env.BETTER_AUTH_SECRET, {
        action, email, askId, ttlSeconds: ASK_ACTION_TTL_SECONDS, now: now.getTime(),
      })}`;
    for (const a of own) links[a.id] = a.ado_managed ? { ado: a.ado_url } : { done: await link("done", a.id), snooze: await link("snooze", a.id) };
    for (const a of free) links[a.id] = a.ado_managed ? { ado: a.ado_url } : { claim: await link("claim", a.id) };
    const unsubscribeUrl = `${appUrl}${EMAIL_ACTION_PATH}?t=${await signActionToken(env.BETTER_AUTH_SECRET, {
      action: "unsub", email, ttlSeconds: PREF_ACTION_TTL_SECONDS, now: now.getTime(),
    })}`;

    const message = buildDigestEmail({ email, today, own, free, links, appUrl: appUrl || "/", unsubscribeUrl });
    const result = await deps.sendEmail(env, { kind: "Daily digest", ...message });
    if (result?.ok) {
      await env.DB.prepare("UPDATE relay_daily_digests SET item_count = ? WHERE email = ? AND digest_date = ?")
        .bind(own.length + free.length, email, today).run();
      sent++;
    } else {
      // Αποτυχία: ξεκλείδωμα ώστε να ξαναδοκιμαστεί στο επόμενο cron (μέσα στο πρωινό παράθυρο).
      await env.DB.prepare("DELETE FROM relay_daily_digests WHERE email = ? AND digest_date = ?").bind(email, today).run();
    }
  }
  return { sent, recipients: byEmail.size };
}

// ---------- Σελίδες ενεργειών (/api/email-action) ----------
function page(title, bodyHtml, status = 200) {
  const html = `<!doctype html><html lang="el"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${esc(title)} · Relay</title><style>` +
    `body{margin:0;background:${COLORS.bg};font-family:Segoe UI,Arial,sans-serif;color:${COLORS.ink}}` +
    `main{max-width:440px;margin:12vh auto 0;background:#fff;border-radius:14px;padding:28px 24px;box-shadow:0 2px 12px rgba(0,0,0,.06)}` +
    `h1{font-size:20px;margin:0 0 8px}p{color:${COLORS.muted};line-height:1.5;margin:6px 0}` +
    `.task{color:${COLORS.ink};font-weight:600;font-size:16px}` +
    `button,.btn{display:inline-block;margin-top:18px;padding:12px 20px;border:0;border-radius:10px;font-size:16px;font-weight:600;` +
    `background:${COLORS.brand};color:#fff;text-decoration:none;cursor:pointer}` +
    `.secondary{background:#fff;color:${COLORS.brand};border:1px solid ${COLORS.line};margin-left:8px}` +
    `@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937}.task{color:#f9fafb}h1{color:#f9fafb}` +
    `.secondary{background:#1f2937}}</style></head><body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

const ACTION_COPY = {
  done: { title: "Ολοκλήρωση ενέργειας", question: "Να σημειωθεί ως ολοκληρωμένη;", cta: "✔ Ναι, έγινε" },
  snooze: { title: "Μετάθεση προθεσμίας", question: "Να μετατεθεί η προθεσμία κατά μία ημέρα;", cta: "⏭ Μετάθεση" },
  claim: { title: "Ανάληψη ενέργειας", question: "Να την αναλάβεις εσύ;", cta: "🙋 Ανάληψη" },
  unsub: { title: "Διακοπή πρωινού email", question: "Να σταματήσει το πρωινό email «Τα δικά σου σήμερα»;", cta: "Διακοπή" },
  resub: { title: "Πρωινό email", question: "Να ενεργοποιηθεί ξανά το πρωινό email;", cta: "Ενεργοποίηση" },
};

function openRelayButton(appUrl, extraClass = "") {
  return `<a class="btn ${extraClass}" href="${esc(appUrl || "/")}">Άνοιξε το Relay</a>`;
}

async function loadAsk(env, askId) {
  return env.DB.prepare(
    `SELECT a.id, a.title, a.owner, a.status, a.due_date, a.project_id, p.name AS project_name, p.created_by_user_id
     FROM asks a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`
  ).bind(askId).first();
}

async function isProjectParticipant(env, ask, email) {
  const member = await env.DB.prepare("SELECT 1 AS ok FROM relay_project_members WHERE project_id = ? AND email = ?")
    .bind(ask.project_id, email).first();
  if (member) return true;
  if (!ask.created_by_user_id) return false;
  const creator = await env.DB.prepare("SELECT lower(email) AS email FROM relay_users WHERE id = ?").bind(ask.created_by_user_id).first();
  return creator?.email === email;
}

// Επιστρέφει { ok, message } ή { error } — ελέγχει δικαιώματα τη στιγμή του κλικ, όχι της αποστολής.
async function applyAction(env, { action, email, askId }, today) {
  if (action === "unsub" || action === "resub") {
    await env.DB.prepare(
      `INSERT INTO relay_email_prefs (email, daily_digest, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET daily_digest = excluded.daily_digest, updated_at = excluded.updated_at`
    ).bind(email, action === "unsub" ? 0 : 1, new Date().toISOString()).run();
    return { ok: true, message: action === "unsub" ? "Δεν θα λαμβάνεις πια το πρωινό email." : "Το πρωινό email ενεργοποιήθηκε ξανά." };
  }

  const ask = await loadAsk(env, askId);
  if (!ask) return { error: "Η ενέργεια δεν υπάρχει πια." };
  if (await adoLockedAsk(env, askId)) return { error: ADO_LOCKED_MESSAGE };
  const owner = String(ask.owner || "").trim().toLowerCase();
  const event = (type, note) => env.DB.prepare("INSERT INTO events (id, ask_id, type, note) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), askId, type, note).run();

  if (action === "claim") {
    if (owner === email) return { ok: true, message: "Είναι ήδη δική σου." };
    if (owner) return { error: `Την έχει ήδη αναλάβει ${owner}.` };
    if (!(await isProjectParticipant(env, ask, email))) return { error: "Δεν είσαι πια μέλος αυτού του project." };
    const res = await env.DB.prepare("UPDATE asks SET owner = ? WHERE id = ? AND (owner IS NULL OR trim(owner) = '')")
      .bind(email, askId).run();
    if (!res.meta?.changes) return { error: "Μόλις την ανέλαβε κάποιος άλλος." };
    await event("updated", `Claimed by ${email} (email)`);
    return { ok: true, message: "Την ανέλαβες. Θα εμφανίζεται στο πρωινό σου email." };
  }

  if (owner !== email) return { error: "Η ενέργεια δεν είναι πια στο όνομά σου." };

  if (action === "done") {
    if (ask.status === "done") return { ok: true, message: "Ήταν ήδη ολοκληρωμένη." };
    await env.DB.prepare("UPDATE asks SET status = 'done' WHERE id = ?").bind(askId).run();
    await event("done", `Completed by ${email} (email)`);
    return { ok: true, message: "Μπράβο! Σημειώθηκε ως ολοκληρωμένη." };
  }

  // snooze: η νέα προθεσμία είναι αύριο (αν έχει λήξει ή λήγει σήμερα), αλλιώς +1 ημέρα.
  if (ask.status === "done") return { ok: true, message: "Είναι ήδη ολοκληρωμένη." };
  const base = ask.due_date && ask.due_date > today ? ask.due_date : today;
  const newDue = addDays(base, 1);
  await env.DB.prepare("UPDATE asks SET due_date = ? WHERE id = ?").bind(newDue, askId).run();
  await event("slipped", `Due ${ask.due_date || "—"} → ${newDue} by ${email} (email)`);
  return { ok: true, message: `Νέα προθεσμία: ${shortDate(newDue)}.` };
}

export async function handleEmailAction(request, env, now = new Date()) {
  const appUrl = env.BETTER_AUTH_URL || "";
  let token = "";
  if (request.method === "GET") {
    token = new URL(request.url).searchParams.get("t") || "";
  } else if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    token = String(form?.get("t") || "");
  } else {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }

  const claims = await verifyActionToken(env.BETTER_AUTH_SECRET, token, now.getTime());
  if (claims.error) {
    const expired = claims.error === "expired";
    return page(expired ? "Ο σύνδεσμος έληξε" : "Μη έγκυρος σύνδεσμος",
      `<h1>${expired ? "Ο σύνδεσμος έληξε" : "Μη έγκυρος σύνδεσμος"}</h1>` +
      `<p>${expired ? "Οι σύνδεσμοι του email ισχύουν λίγες ημέρες." : "Ο σύνδεσμος δεν αναγνωρίστηκε."} Κάνε την αλλαγή από το Relay.</p>` +
      openRelayButton(appUrl), expired ? 410 : 400);
  }

  const copy = ACTION_COPY[claims.action];
  const isAskAction = ASK_ACTIONS.includes(claims.action);
  const ask = isAskAction ? await loadAsk(env, claims.askId) : null;
  if (isAskAction && !ask) {
    return page("Δεν βρέθηκε", `<h1>Δεν βρέθηκε</h1><p>Η ενέργεια δεν υπάρχει πια.</p>${openRelayButton(appUrl)}`, 404);
  }
  const taskHtml = ask
    ? `<p class="task">${esc(ask.title)}</p><p>${esc(ask.project_name)} · ${esc(dueLabel(ask.due_date || "", athensClock(now).date))}</p>`
    : `<p>${esc(claims.email)}</p>`;

  if (request.method === "GET") {
    return page(copy.title,
      `<h1>${esc(copy.question)}</h1>${taskHtml}` +
      `<form method="post" action="${EMAIL_ACTION_PATH}"><input type="hidden" name="t" value="${esc(token)}">` +
      `<button type="submit">${esc(copy.cta)}</button>${openRelayButton(appUrl, "secondary")}</form>`);
  }

  const result = await applyAction(env, claims, athensClock(now).date);
  if (result.error) {
    return page(copy.title, `<h1>Δεν έγινε η αλλαγή</h1>${taskHtml}<p>${esc(result.error)}</p>${openRelayButton(appUrl)}`, 409);
  }
  const undo = claims.action === "unsub"
    ? `<form method="post" action="${EMAIL_ACTION_PATH}"><input type="hidden" name="t" value="${esc(
        await signActionToken(env.BETTER_AUTH_SECRET, { action: "resub", email: claims.email, ttlSeconds: PREF_ACTION_TTL_SECONDS, now: now.getTime() })
      )}"><button type="submit" class="secondary" style="margin-left:0">Άλλαξα γνώμη, ενεργοποίηση ξανά</button></form>`
    : "";
  return page(copy.title, `<h1>✔ Έγινε</h1>${taskHtml}<p>${esc(result.message)}</p>${openRelayButton(appUrl)}${undo}`);
}
