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
    throw new AdoError("ado_error", `${ADO_MESSAGES.ado_error} (${response.status})`);
  }
  return response.json();
}

const wiqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const splitList = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);

async function listIds(env, link) {
  const root = witRoot(env, link);
  let res;
  if (link.query_id) {
    res = await adoCall(env, "GET", `${root}/wiql/${encodeURIComponent(link.query_id)}?api-version=${API_VERSION}`);
  } else {
    const types = splitList(link.work_item_types);
    const states = splitList(link.exclude_states);
    const where = [`[System.TeamProject] = ${wiqlString(link.ado_project)}`];
    if (types.length) where.push(`[System.WorkItemType] IN (${types.map(wiqlString).join(",")})`);
    if (states.length) where.push(`[System.State] NOT IN (${states.map(wiqlString).join(",")})`);
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
  };
}

export async function fetchWorkItems(env, link) {
  const ids = await listIds(env, link);
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const res = await adoCall(env, "POST", `${witRoot(env, link)}/workitemsbatch?api-version=${API_VERSION}`, {
      ids: ids.slice(i, i + 200), fields: FIELDS,
    });
    for (const w of res.value || []) items.push(normalizeWorkItem(w));
  }
  return items;
}

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
  return { org, ado_project: adoProject, query_id: queryId || null, work_item_types: types.join(","), exclude_states: states.join(",") };
}

async function getLink(env, projectId) {
  return env.DB.prepare("SELECT * FROM relay_ado_links WHERE project_id = ?").bind(projectId).first();
}

function publicLink(link) {
  return link && {
    org: link.org, ado_project: link.ado_project, query_id: link.query_id || "",
    work_item_types: link.work_item_types, exclude_states: link.exclude_states, updated_at: link.updated_at,
  };
}

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
  const match = path.match(/^\/api\/projects\/([^/]+)\/ado(?:\/items(?:\/([^/]+)\/ask)?)?$/);
  if (!match) return null;
  const { json } = deps;
  const projectId = decodeURIComponent(match[1]);
  const workItemId = match[2] ? decodeURIComponent(match[2]) : null;
  const isItems = path.endsWith("/ado/items");

  const project = await deps.getAccessibleProject(env, actor, projectId);
  if (!project) return json({ error: "Project not found" }, 404);
  const link = await getLink(env, project.id);

  // Ρυθμίσεις σύνδεσης
  if (!isItems && !workItemId) {
    if (request.method === "GET") {
      return json({ link: publicLink(link), token_configured: !!env.ADO_PAT, can_configure: deps.isAdmin(actor) });
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      if (!deps.isAdmin(actor)) return json({ error: "Τη σύνδεση με το ADO την ορίζει μόνο admin." }, 403);
      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM relay_ado_cache WHERE project_id = ?").bind(project.id),
          env.DB.prepare("DELETE FROM relay_ado_links WHERE project_id = ?").bind(project.id),
        ]);
        return json({ ok: true });
      }
      const parsed = parseLinkInput(await request.json().catch(() => ({})));
      if (parsed.error) return json({ error: parsed.error }, 400);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO relay_ado_links (project_id, org, ado_project, query_id, work_item_types, exclude_states, updated_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET org = excluded.org, ado_project = excluded.ado_project, query_id = excluded.query_id,
             work_item_types = excluded.work_item_types, exclude_states = excluded.exclude_states,
             updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`
        ).bind(project.id, parsed.org, parsed.ado_project, parsed.query_id, parsed.work_item_types, parsed.exclude_states,
          actor.id, new Date().toISOString()),
        env.DB.prepare("DELETE FROM relay_ado_cache WHERE project_id = ?").bind(project.id),
      ]);
      return json({ ok: true, link: publicLink(await getLink(env, project.id)) });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (!link) return json({ error: "Το project δεν έχει συνδεθεί με ADO.", code: "not_linked" }, 409);

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
