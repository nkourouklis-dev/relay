// Relay — Azure DevOps, read-only (ADO Φάση 1).
//
// - Ένα κοινό token ως Cloudflare secret: ADO_PAT (scope ΜΟΝΟ «Work Items: Read»). Δεν φτάνει ποτέ στον browser.
// - Ανά project του Relay ένα ADO org/project (+ προαιρετικό shared query) σε relay_ado_links· το ορίζει μόνο admin,
//   ώστε το κοινό token να μη γίνεται «παράθυρο» σε ADO projects που ο χρήστης δεν θα έβλεπε αλλιώς.
// - Λίστα με cache 5' σε D1· αν το ADO δεν απαντά, δείχνουμε τα τελευταία γνωστά με ένδειξη stale.
// - «→ Ενέργεια»: φτιάχνει ask με link στο ADO, μία φορά ανά work item (external_import_key).
// - Δεν γράφει ΤΙΠΟΤΑ στο ADO.
// Η λογική του connector (WIQL + workitemsbatch, 203 = άκυρο token) προέρχεται από το IT Control Tower.

const API_VERSION = "7.1";
const CACHE_MS = 5 * 60 * 1000;
const MAX_ITEMS = 1000;
const FIELDS = [
  "System.Id", "System.WorkItemType", "System.Title", "System.State",
  "Microsoft.VSTS.Common.Severity", "Microsoft.VSTS.Common.Priority",
  "System.AssignedTo", "System.Tags", "System.CreatedDate", "System.ChangedDate",
  "System.AreaPath", "System.IterationPath",
];
// Πεδία προθεσμίας: δεν υπάρχουν σε όλα τα processes· αν το ADO τα απορρίψει, ξαναζητάμε χωρίς αυτά.
const DATE_FIELDS = ["Microsoft.VSTS.Scheduling.DueDate", "Microsoft.VSTS.Scheduling.TargetDate"];
const RECENTLY_CLOSED_DAYS = 30;
const MIRROR_MIN_INTERVAL_MS = 60 * 1000;
const ORG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_ITEM_PATTERN = /^[\p{L}\p{N} ._-]{1,60}$/u;

class AdoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const ADO_MESSAGES = {
  not_configured: "Δεν έχει οριστεί token για το ADO (Cloudflare secret ADO_PAT).",
  auth_failed: "Το ADO απέρριψε το token (άκυρο ή ληγμένο).",
  forbidden: "Το token δεν έχει «Work Items: Read» ή δεν έχει πρόσβαση σε αυτό το ADO project.",
  not_found: "Δεν βρέθηκε το ADO organization/project ή το query.",
  ado_error: "Το ADO επέστρεψε σφάλμα.",
  network: "Δεν ήταν δυνατή η σύνδεση με το ADO.",
};

function baseUrl(env) {
  return String(env.ADO_BASE_URL || "https://dev.azure.com").replace(/\/$/, "");
}

function witRoot(env, link) {
  return `${baseUrl(env)}/${encodeURIComponent(link.org)}/${encodeURIComponent(link.ado_project)}/_apis/wit`;
}

export function workItemUrl(env, link, id) {
  return `${baseUrl(env)}/${encodeURIComponent(link.org)}/${encodeURIComponent(link.ado_project)}/_workitems/edit/${encodeURIComponent(id)}`;
}

async function adoCall(env, method, url, body) {
  if (!env.ADO_PAT) throw new AdoError("not_configured", ADO_MESSAGES.not_configured);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`:${env.ADO_PAT}`)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
  } catch {
    throw new AdoError("network", ADO_MESSAGES.network);
  }
  const contentType = response.headers.get("content-type") || "";
  // Το ADO απαντά 203 + HTML σελίδα login (ή redirect) όταν το token είναι άκυρο/ληγμένο.
  if (response.status === 203 || response.status === 401 || (response.status >= 300 && response.status < 400) ||
      (response.ok && !contentType.includes("json"))) {
    throw new AdoError("auth_failed", ADO_MESSAGES.auth_failed);
  }
  if (response.status === 403) throw new AdoError("forbidden", ADO_MESSAGES.forbidden);
  if (response.status === 404) throw new AdoError("not_found", ADO_MESSAGES.not_found);
  if (!response.ok) {
    console.log("ADO error", { status: response.status });
    const error = new AdoError("ado_error", `${ADO_MESSAGES.ado_error} (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const wiqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const splitList = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);

// includeRecentlyClosed: για τον καθρέφτη — φέρνει και όσα έκλεισαν πρόσφατα, ώστε να κλείσουν και στο Relay.
async function listIds(env, link, { includeRecentlyClosed = false } = {}) {
  const root = witRoot(env, link);
  let res;
  if (link.query_id) {
    res = await adoCall(env, "GET", `${root}/wiql/${encodeURIComponent(link.query_id)}?api-version=${API_VERSION}`);
  } else {
    const types = splitList(link.work_item_types);
    const states = splitList(link.exclude_states);
    const where = [`[System.TeamProject] = ${wiqlString(link.ado_project)}`];
    if (link.area_path) where.push(`[System.AreaPath] UNDER ${wiqlString(link.area_path)}`);
    if (types.length) where.push(`[System.WorkItemType] IN (${types.map(wiqlString).join(",")})`);
    if (states.length) {
      const open = `[System.State] NOT IN (${states.map(wiqlString).join(",")})`;
      where.push(includeRecentlyClosed ? `(${open} OR [System.ChangedDate] >= @Today - ${RECENTLY_CLOSED_DAYS})` : open);
    }
    const query = `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
    res = await adoCall(env, "POST", `${root}/wiql?api-version=${API_VERSION}`, { query });
  }
  const ids = (res.workItems || []).map((w) => w.id)
    .concat((res.workItemRelations || []).map((r) => r.target && r.target.id).filter(Boolean));
  return [...new Set(ids)].slice(0, MAX_ITEMS);
}

function person(value) {
  if (!value) return { name: "", email: "" };
  if (typeof value === "string") {
    const m = value.match(/<([^>]+@[^>]+)>/);
    return { name: value.replace(/\s*<[^>]*>\s*/, "").trim(), email: m ? m[1].toLowerCase() : "" };
  }
  const unique = String(value.uniqueName || "");
  return { name: value.displayName || unique, email: unique.includes("@") ? unique.toLowerCase() : "" };
}

export function normalizeWorkItem(w) {
  const f = w.fields || {};
  const assigned = person(f["System.AssignedTo"]);
  return {
    id: String(w.id),
    type: f["System.WorkItemType"] || "",
    title: f["System.Title"] || "",
    state: f["System.State"] || "",
    severity: f["Microsoft.VSTS.Common.Severity"] || "",
    priority: f["Microsoft.VSTS.Common.Priority"] != null ? String(f["Microsoft.VSTS.Common.Priority"]) : "",
    assigned_name: assigned.name,
    assigned_email: assigned.email,
    tags: f["System.Tags"] || "",
    created: f["System.CreatedDate"] || "",
    changed: f["System.ChangedDate"] || "",
    area: f["System.AreaPath"] || "",
    iteration: f["System.IterationPath"] || "",
    due_date: String(f["Microsoft.VSTS.Scheduling.DueDate"] || f["Microsoft.VSTS.Scheduling.TargetDate"] || "").slice(0, 10),
  };
}

// Batch λήψη με errorPolicy=omit (σβησμένα / χωρίς πρόσβαση απλώς λείπουν).
async function fetchByIds(env, link, ids) {
  const items = [];
  let fields = [...FIELDS, ...DATE_FIELDS];
  for (let i = 0; i < ids.length; i += 200) {
    const body = (f) => ({ ids: ids.slice(i, i + 200).map(Number), fields: f, errorPolicy: "omit" });
    let res;
    try {
      res = await adoCall(env, "POST", `${witRoot(env, link)}/workitemsbatch?api-version=${API_VERSION}`, body(fields));
    } catch (error) {
      if (!(error instanceof AdoError) || error.status !== 400 || fields === FIELDS) throw error;
      fields = FIELDS; // το process δεν έχει πεδία προθεσμίας
      res = await adoCall(env, "POST", `${witRoot(env, link)}/workitemsbatch?api-version=${API_VERSION}`, body(fields));
    }
    for (const w of res.value || []) if (w) items.push(normalizeWorkItem(w));
  }
  return items;
}

export async function fetchWorkItems(env, link, options = {}) {
  return fetchByIds(env, link, await listIds(env, link, options));
}

// ---------- Χαρτογράφηση ADO → Ενέργεια ----------
const DONE_STATES = ["closed", "done", "removed", "completed", "cut"];
const OPEN_STATES = ["new", "proposed", "to do", "approved", "design", ""];

export function statusFromState(state, excludeStates = "") {
  const s = String(state || "").trim().toLowerCase();
  if (DONE_STATES.includes(s) || splitList(excludeStates).some((x) => x.toLowerCase() === s)) return "done";
  if (OPEN_STATES.includes(s)) return "open";
  return "accepted"; // Active, Committed, In Progress, Resolved (αναμένει επαλήθευση) κλπ.
}

export function priorityFrom(item) {
  const m = String(item.severity || "").match(/^(\d)/) || String(item.priority || "").match(/^(\d)/);
  return m ? ({ 1: "critical", 2: "high", 3: "medium", 4: "low" })[m[1]] || null : null;
}

const mirrorTitle = (item) => `#${item.id} ${item.title}`.slice(0, 240);

// Επιστρέφει { org, ado_project, query_id, work_item_types, exclude_states } ή { error }.
export function parseLinkInput(b) {
  const org = String(b.org || "").trim();
  const adoProject = String(b.ado_project || "").trim();
  const queryId = String(b.query_id || "").trim();
  const types = splitList(b.work_item_types ?? "Bug");
  const states = splitList(b.exclude_states ?? "Closed,Done,Removed");
  if (!ORG_PATTERN.test(org)) return { error: "Μη έγκυρο ADO organization (όπως στο dev.azure.com/<org>)." };
  if (!adoProject || adoProject.length > 64 || /[/\\?#%&<>'"]/.test(adoProject)) return { error: "Μη έγκυρο όνομα ADO project." };
  if (queryId && !GUID_PATTERN.test(queryId)) return { error: "Το Query ID πρέπει να είναι GUID (από το URL του shared query)." };
  if (types.length > 10 || !types.every((t) => LIST_ITEM_PATTERN.test(t))) return { error: "Μη έγκυροι τύποι work items." };
  if (states.length > 15 || !states.every((s) => LIST_ITEM_PATTERN.test(s))) return { error: "Μη έγκυρα states προς εξαίρεση." };
  const areaPath = String(b.area_path || "").trim();
  if (areaPath && (areaPath.length > 256 || /[/?#%&<>'"]/.test(areaPath))) {
    return { error: "Μη έγκυρο Area Path (π.χ. Edison-B2B\\B2C GR)." };
  }
  return {
    org, ado_project: adoProject, query_id: queryId || null, work_item_types: types.join(","), exclude_states: states.join(","),
    area_path: areaPath || null, auto_mirror: b.auto_mirror === false ? 0 : 1,
  };
}

async function getLink(env, projectId) {
  return env.DB.prepare("SELECT * FROM relay_ado_links WHERE project_id = ?").bind(projectId).first();
}

function publicLink(link) {
  return link && {
    org: link.org, ado_project: link.ado_project, query_id: link.query_id || "", area_path: link.area_path || "",
    work_item_types: link.work_item_types, exclude_states: link.exclude_states, updated_at: link.updated_at,
    auto_mirror: link.auto_mirror !== 0, last_mirror_at: link.last_mirror_at || null,
    last_mirror_error: link.last_mirror_error || null, last_mirror_count: link.last_mirror_count ?? null,
  };
}

// ---------- Καθρέφτης ADO → Ενέργειες ----------
// Το ADO είναι η αλήθεια για: τίτλο, status, υπεύθυνο, προθεσμία, προτεραιότητα, link.
// Του Relay μένουν: φάση (section), story points, sprint, υπενθυμίσεις, σχόλια/ιστορικό.
// Υπεύθυνος μόνο όταν το email του ADO είναι ακριβώς μέλος του project. Δεν στέλνονται emails ανάθεσης
// (θα έφευγαν εκατοντάδες στον πρώτο συγχρονισμό)· οι άνθρωποι τα βλέπουν στο πρωινό email.
async function projectMemberEmails(env, project) {
  const { results } = await env.DB.prepare(
    `SELECT lower(email) AS email FROM relay_users WHERE id = ?
     UNION SELECT lower(email) FROM relay_project_members WHERE project_id = ?`
  ).bind(project.created_by_user_id || "", project.id).all();
  return new Set((results || []).map((r) => r.email).filter(Boolean));
}

async function runBatches(env, statements, size = 50) {
  for (let i = 0; i < statements.length; i += size) await env.DB.batch(statements.slice(i, i + size));
}

export async function mirrorProject(env, project, link, now = new Date()) {
  const nowIso = now.toISOString();
  const items = await fetchWorkItems(env, link, { includeRecentlyClosed: true });
  const seen = new Set(items.map((i) => i.id));

  // Ό,τι είχαμε ανοιχτό αλλά δεν ήρθε (π.χ. κλειστό εκτός 30 ημερών, άλλαξε area): φέρνουμε την τρέχουσα κατάστασή του.
  const { results: openMirrored } = await env.DB.prepare(
    `SELECT i.work_item_id FROM relay_ado_items i JOIN asks a ON a.id = i.ask_id
     WHERE i.project_id = ? AND COALESCE(a.status, 'open') != 'done'`
  ).bind(project.id).all();
  const missing = (openMirrored || []).map((r) => r.work_item_id).filter((id) => !seen.has(id));
  const refreshed = missing.length ? await fetchByIds(env, link, missing) : [];
  const gone = new Set(missing);
  for (const item of refreshed) { gone.delete(item.id); items.push(item); }

  const members = await projectMemberEmails(env, project);
  const { results: existingRows } = await env.DB.prepare(
    `SELECT id, external_import_key, title, status, owner, assignees, due_date, priority, ado_url
     FROM asks WHERE project_id = ? AND external_import_key LIKE 'ado:%'`
  ).bind(project.id).all();
  const existing = new Map((existingRows || []).map((r) => [r.external_import_key, r]));
  const createdBy = link.updated_by_user_id || project.created_by_user_id || null;

  const statements = [];
  const event = (askId, type, note) => env.DB.prepare("INSERT INTO events (id, ask_id, type, note) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), askId, type, note.slice(0, 300));
  let created = 0, updated = 0;

  for (const item of items) {
    const key = askKey(link, item.id);
    const wanted = {
      title: mirrorTitle(item),
      status: statusFromState(item.state, link.exclude_states),
      owner: item.assigned_email && members.has(item.assigned_email) ? item.assigned_email : "",
      assignees: item.assigned_name || "",
      due_date: item.due_date || null,
      priority: priorityFrom(item),
      ado_url: workItemUrl(env, link, item.id),
    };
    const row = existing.get(key);
    if (!row && wanted.status === "done") continue; // ήδη κλειστό στο ADO: δεν το φέρνουμε ως νέα Ενέργεια
    let askId = row?.id;
    if (!row) {
      askId = crypto.randomUUID();
      const quote = [`ADO ${item.type || "Work item"} #${item.id}`, item.state && `State: ${item.state}`,
        item.severity && `Severity: ${item.severity}`, item.assigned_name && `Assigned: ${item.assigned_name}`].filter(Boolean).join(" · ");
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO asks (id, project_id, title, owner, assignees, requested_by, created_by, created_by_user_id,
           due_date, status, priority, source_quote, ado_url, external_import_key)
         VALUES (?, ?, ?, ?, ?, 'Azure DevOps', 'Azure DevOps', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(askId, project.id, wanted.title, wanted.owner, wanted.assignees, createdBy, wanted.due_date, wanted.status,
        wanted.priority, quote, wanted.ado_url, key));
      statements.push(event(askId, "created", `From ADO #${item.id} (${item.state || "—"})`));
      created++;
    } else {
      const changes = Object.keys(wanted).filter((k) => String(row[k] ?? "") !== String(wanted[k] ?? ""));
      if (changes.length) {
        statements.push(env.DB.prepare(`UPDATE asks SET ${changes.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
          .bind(...changes.map((k) => wanted[k]), askId));
        const notes = [];
        if (changes.includes("status")) notes.push(`ADO state: ${item.state}`);
        if (changes.includes("owner") || changes.includes("assignees")) notes.push(`ADO assigned: ${item.assigned_name || "—"}`);
        if (changes.includes("due_date")) notes.push(`ADO due: ${wanted.due_date || "—"}`);
        if (changes.includes("title")) notes.push("ADO title changed");
        if (notes.length) statements.push(event(askId, changes.includes("status") && wanted.status === "done" ? "done" : "updated", notes.join("; ")));
        updated++;
      }
    }
    statements.push(env.DB.prepare(
      `INSERT INTO relay_ado_items (project_id, work_item_id, ask_id, work_item_type, state, severity, assigned_name, assigned_email,
         area_path, iteration_path, tags, changed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, work_item_id) DO UPDATE SET ask_id = excluded.ask_id, work_item_type = excluded.work_item_type,
         state = excluded.state, severity = excluded.severity, assigned_name = excluded.assigned_name,
         assigned_email = excluded.assigned_email, area_path = excluded.area_path, iteration_path = excluded.iteration_path,
         tags = excluded.tags, changed_at = excluded.changed_at, last_seen_at = excluded.last_seen_at`
    ).bind(project.id, item.id, askId, item.type, item.state, item.severity, item.assigned_name, item.assigned_email,
      item.area, item.iteration, item.tags, item.changed, nowIso));
  }

  // Σβησμένα στο ADO (ή χωρίς πλέον πρόσβαση): κλείνουν στο Relay με σημείωση — δεν σβήνονται.
  for (const workItemId of gone) {
    const row = existing.get(askKey(link, workItemId));
    if (!row || row.status === "done") continue;
    statements.push(env.DB.prepare("UPDATE asks SET status = 'done' WHERE id = ?").bind(row.id));
    statements.push(event(row.id, "done", `ADO #${workItemId} δεν υπάρχει πλέον (σβήστηκε ή χωρίς πρόσβαση)`));
    updated++;
  }

  statements.push(env.DB.prepare(
    "UPDATE relay_ado_links SET last_mirror_at = ?, last_mirror_error = NULL, last_mirror_count = ? WHERE project_id = ?"
  ).bind(nowIso, items.length, project.id));
  await runBatches(env, statements);
  return { items: items.length, created, updated };
}

async function recordMirrorError(env, projectId, error, now = new Date()) {
  await env.DB.prepare("UPDATE relay_ado_links SET last_mirror_at = ?, last_mirror_error = ? WHERE project_id = ?")
    .bind(now.toISOString(), String(error.code || error.message || "error").slice(0, 200), projectId).run();
}

// Cron: όλα τα projects με auto_mirror. Ένα αποτυχημένο project δεν σταματά τα υπόλοιπα.
export async function dispatchAdoMirrors(env, now = new Date()) {
  if (!env.ADO_PAT) return { skipped: "not_configured" };
  const { results } = await env.DB.prepare(
    `SELECT l.*, p.created_by_user_id, p.name AS project_name FROM relay_ado_links l JOIN projects p ON p.id = l.project_id
     WHERE l.auto_mirror = 1`
  ).all();
  const summary = [];
  for (const link of results || []) {
    const project = { id: link.project_id, name: link.project_name, created_by_user_id: link.created_by_user_id };
    try {
      summary.push({ project_id: project.id, ...(await mirrorProject(env, project, link, now)) });
    } catch (error) {
      console.log("ADO mirror failed", { project_id: project.id, error: String(error.code || error.message) });
      await recordMirrorError(env, project.id, error, now);
      summary.push({ project_id: project.id, error: error.code || "error" });
    }
  }
  return { projects: summary };
}

// Projects όπου το ADO είναι η αλήθεια (για κλείδωμα πεδίων). Αν λείπει η migration, κανένα.
export async function adoManagedProjectIds(env) {
  try {
    const { results } = await env.DB.prepare("SELECT project_id FROM relay_ado_links WHERE auto_mirror = 1").all();
    return new Set((results || []).map((r) => r.project_id));
  } catch {
    return new Set();
  }
}

export function isAdoKey(key) {
  return String(key || "").startsWith("ado:");
}

// Επιστρέφει το ADO link αν το ask ελέγχεται από το ADO, αλλιώς null.
export async function adoLockedAsk(env, askId) {
  try {
    return await env.DB.prepare(
      `SELECT a.id, a.ado_url, a.section, a.story_points, a.sprint_id FROM asks a
       JOIN relay_ado_links l ON l.project_id = a.project_id AND l.auto_mirror = 1
       WHERE a.id = ? AND a.external_import_key LIKE 'ado:%'`
    ).bind(askId).first();
  } catch {
    return null;
  }
}

export const ADO_LOCKED_MESSAGE = "Αυτή η ενέργεια έρχεται από το Azure DevOps: τίτλος, status, υπεύθυνος και προθεσμία αλλάζουν στο ADO.";

async function linkedAsks(env, projectId) {
  const { results } = await env.DB.prepare(
    "SELECT id, external_import_key, status FROM asks WHERE project_id = ? AND external_import_key LIKE 'ado:%'"
  ).bind(projectId).all();
  return new Map((results || []).map((r) => [r.external_import_key, { id: r.id, status: r.status }]));
}

const askKey = (link, workItemId) => `ado:${link.org}/${link.ado_project}#${workItemId}`;

// Λίστα με cache: { items, synced_at, cached, stale, error? }
async function loadItems(env, projectId, link, { refresh = false, now = Date.now() } = {}) {
  const cache = await env.DB.prepare("SELECT payload_json, synced_at FROM relay_ado_cache WHERE project_id = ?").bind(projectId).first();
  let cached = null;
  if (cache) {
    try {
      const payload = JSON.parse(cache.payload_json);
      if (payload.key === askKey(link, "")) cached = { items: payload.items, synced_at: cache.synced_at };
    } catch { /* χαλασμένο cache: αγνοείται */ }
  }
  if (!refresh && cached && now - Date.parse(cached.synced_at) < CACHE_MS) return { ...cached, cached: true, stale: false };
  try {
    const items = await fetchWorkItems(env, link);
    const syncedAt = new Date(now).toISOString();
    await env.DB.prepare(
      `INSERT INTO relay_ado_cache (project_id, payload_json, synced_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET payload_json = excluded.payload_json, synced_at = excluded.synced_at`
    ).bind(projectId, JSON.stringify({ key: askKey(link, ""), items }), syncedAt).run();
    return { items, synced_at: syncedAt, cached: false, stale: false };
  } catch (error) {
    if (!(error instanceof AdoError)) throw error;
    if (cached) return { ...cached, cached: true, stale: true, error: error.code, message: error.message };
    throw error;
  }
}

// deps: { json, getAccessibleProject, canManageProject, isAdmin, resolveProjectAssignee, notifyAssignments, uid }
// Επιστρέφει Response ή null αν το path δεν αφορά το ADO.
export async function handleAdoRoute(request, env, { path, url, actor, sessionEmail }, deps) {
  const match = path.match(/^\/api\/projects\/([^/]+)\/ado(?:\/sync|\/items(?:\/([^/]+)\/ask)?)?$/);
  if (!match) return null;
  const { json } = deps;
  const projectId = decodeURIComponent(match[1]);
  const workItemId = match[2] ? decodeURIComponent(match[2]) : null;
  const isItems = path.endsWith("/ado/items");
  const isSync = path.endsWith("/ado/sync");

  const project = await deps.getAccessibleProject(env, actor, projectId);
  if (!project) return json({ error: "Project not found" }, 404);
  const link = await getLink(env, project.id);

  // Ρυθμίσεις σύνδεσης
  if (!isItems && !isSync && !workItemId) {
    if (request.method === "GET") {
      return json({ link: publicLink(link), token_configured: !!env.ADO_PAT, can_configure: deps.isAdmin(actor) });
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      if (!deps.isAdmin(actor)) return json({ error: "Τη σύνδεση με το ADO την ορίζει μόνο admin." }, 403);
      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM relay_ado_cache WHERE project_id = ?").bind(project.id),
          env.DB.prepare("DELETE FROM relay_ado_items WHERE project_id = ?").bind(project.id),
          env.DB.prepare("DELETE FROM relay_ado_links WHERE project_id = ?").bind(project.id),
        ]);
        return json({ ok: true });
      }
      const parsed = parseLinkInput(await request.json().catch(() => ({})));
      if (parsed.error) return json({ error: parsed.error }, 400);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO relay_ado_links (project_id, org, ado_project, query_id, work_item_types, exclude_states, area_path, auto_mirror,
             updated_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET org = excluded.org, ado_project = excluded.ado_project, query_id = excluded.query_id,
             work_item_types = excluded.work_item_types, exclude_states = excluded.exclude_states, area_path = excluded.area_path,
             auto_mirror = excluded.auto_mirror, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`
        ).bind(project.id, parsed.org, parsed.ado_project, parsed.query_id, parsed.work_item_types, parsed.exclude_states,
          parsed.area_path, parsed.auto_mirror, actor.id, new Date().toISOString()),
        env.DB.prepare("DELETE FROM relay_ado_cache WHERE project_id = ?").bind(project.id),
      ]);
      return json({ ok: true, link: publicLink(await getLink(env, project.id)) });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (!link) return json({ error: "Το project δεν έχει συνδεθεί με ADO.", code: "not_linked" }, 409);

  // Συγχρονισμός τώρα (καθρέφτης): κάθε μέλος, το πολύ μία φορά το λεπτό ανά project.
  if (isSync) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (link.auto_mirror === 0) return json({ error: "Ο αυτόματος συγχρονισμός είναι απενεργοποιημένος για αυτό το project." }, 409);
    if (link.last_mirror_at && Date.now() - Date.parse(link.last_mirror_at) < MIRROR_MIN_INTERVAL_MS) {
      return json({ ok: true, throttled: true, link: publicLink(link) });
    }
    try {
      const result = await mirrorProject(env, project, link);
      await env.DB.prepare("DELETE FROM relay_ado_cache WHERE project_id = ?").bind(project.id).run();
      return json({ ok: true, ...result, link: publicLink(await getLink(env, project.id)) });
    } catch (error) {
      if (!(error instanceof AdoError)) throw error;
      await recordMirrorError(env, project.id, error);
      return json({ error: error.code, message: error.message }, error.code === "not_configured" ? 503 : 502);
    }
  }

  // Live λίστα
  if (isItems) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    try {
      const result = await loadItems(env, project.id, link, { refresh: url.searchParams.get("refresh") === "1" });
      const asks = await linkedAsks(env, project.id);
      return json({
        source: `${link.org}/${link.ado_project}`,
        ...result,
        items: result.items.map((item) => ({
          ...item,
          url: workItemUrl(env, link, item.id),
          ask_id: asks.get(askKey(link, item.id))?.id || null,
        })),
      });
    } catch (error) {
      if (!(error instanceof AdoError)) throw error;
      return json({ error: error.code, message: error.message }, error.code === "not_configured" ? 503 : 502);
    }
  }

  // «→ Ενέργεια»: κάθε μέλος του project. Τα στοιχεία έρχονται από το ADO (cache), όχι από τον browser.
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!/^\d{1,10}$/.test(workItemId)) return json({ error: "Μη έγκυρο work item." }, 400);
  const key = askKey(link, workItemId);
  const existing = await env.DB.prepare("SELECT id FROM asks WHERE project_id = ? AND external_import_key = ?").bind(project.id, key).first();
  if (existing) return json({ ok: true, id: existing.id, existed: true });

  let item;
  try {
    const { items } = await loadItems(env, project.id, link);
    item = items.find((i) => i.id === workItemId);
  } catch (error) {
    if (!(error instanceof AdoError)) throw error;
    return json({ error: error.code, message: error.message }, 502);
  }
  if (!item) return json({ error: "Το work item δεν είναι στη λίστα του ADO για αυτό το project." }, 404);

  // Υπεύθυνος μόνο αν το email του ADO είναι ακριβώς μέλος του project· ποτέ αντιστοίχιση από όνομα.
  const owner = item.assigned_email ? (await deps.resolveProjectAssignee(env, project, item.assigned_email)) || "" : "";
  const id = deps.uid();
  const quote = [`ADO ${item.type || "Work item"} #${item.id}`, item.state && `State: ${item.state}`,
    item.severity && `Severity: ${item.severity}`, item.assigned_name && `Assigned: ${item.assigned_name}`].filter(Boolean).join(" · ");
  const title = `#${item.id} ${item.title}`.slice(0, 240);
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO asks (id, project_id, title, owner, requested_by, created_by, created_by_user_id, source_quote, ado_url, external_import_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, project.id, title, owner, "Azure DevOps", sessionEmail, actor.id, quote, workItemUrl(env, link, item.id), key).run();
  if (!res.meta?.changes) {
    const raced = await env.DB.prepare("SELECT id FROM asks WHERE project_id = ? AND external_import_key = ?").bind(project.id, key).first();
    return json({ ok: true, id: raced?.id || null, existed: true });
  }
  await env.DB.prepare("INSERT INTO events (id, ask_id, type, note) VALUES (?,?,'created',?)")
    .bind(deps.uid(), id, `From ADO #${item.id} by ${sessionEmail}`).run();
  if (owner) {
    await deps.notifyAssignments(env, { project, byEmail: sessionEmail, assignments: [{ owner, title, due_date: null }] });
  }
  return json({ ok: true, id, owner });
}
