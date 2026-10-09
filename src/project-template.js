// Relay — «Νέο rollout από πρότυπο»: νέο project που ξεκινά από ένα υπάρχον (π.χ. B2B GR → B2C GR).
//
// Αντιγράφει (κατ' επιλογή):
// - tasks: τη Master Task List — τίτλο, είδος, φάση, προτεραιότητα, story points, go-live blocking, περιορισμό
//   προθεσμίας και εξαρτήσεις. ΧΩΡΙΣ υπεύθυνο, ημερομηνίες, status, sprint ή ιστορικό: κάθε rollout ξεκινά καθαρό.
//   Δεν αντιγράφονται Ενέργειες που καθρεφτίζονται από ADO (ανήκουν στο ADO του αρχικού project).
// - board: τις στήλες φάσεων του Board.
// - members: τα μέλη, με νέα πρόσκληση (εξωτερικά emails μόνο αν το κάνει admin).
// - ado: σύνδεση με ADO — μόνο admin, και ΜΟΝΟ αν δοθεί Area Path ή Query ID για το νέο rollout,
//   ώστε να μη «διπλοκαθρεφτίσει» όλο το ADO project.

import { parseLinkInput } from "./ado.js";

const MAX_TEMPLATE_TASKS = 1000;

async function runBatches(env, statements, size = 50) {
  for (let i = 0; i < statements.length; i += size) await env.DB.batch(statements.slice(i, i + size));
}

// deps: { createProject, getAccessibleProject, isAdmin, isEmailAllowed, sendProjectInviteEmail }
// Επιστρέφει { project, copied } ή { error, status }.
export async function createProjectFromTemplate(env, actor, body, deps) {
  const template = await deps.getAccessibleProject(env, actor, body.template_project_id);
  if (!template) return { error: "Το πρότυπο project δεν βρέθηκε.", status: 404 };
  const copy = { tasks: true, board: true, members: false, ...(body.copy || {}) };

  // Έλεγχος ADO πριν δημιουργηθεί οτιδήποτε.
  let adoLink = null;
  const adoInput = body.ado || null;
  if (adoInput && (String(adoInput.area_path || "").trim() || String(adoInput.query_id || "").trim())) {
    if (!deps.isAdmin(actor)) return { error: "Τη σύνδεση με το ADO την ορίζει μόνο admin.", status: 403 };
    const source = await env.DB.prepare("SELECT * FROM relay_ado_links WHERE project_id = ?").bind(template.id).first();
    const parsed = parseLinkInput({
      org: adoInput.org || source?.org, ado_project: adoInput.ado_project || source?.ado_project,
      work_item_types: adoInput.work_item_types ?? source?.work_item_types, exclude_states: adoInput.exclude_states ?? source?.exclude_states,
      area_path: adoInput.area_path, query_id: adoInput.query_id, auto_mirror: adoInput.auto_mirror,
    });
    if (parsed.error) return { error: parsed.error, status: 400 };
    adoLink = parsed;
  }

  const project = await deps.createProject(env, body.name, actor.id);
  const nowIso = new Date().toISOString();
  const copied = { tasks: 0, dependencies: 0, board_columns: 0, members: 0, invite_failed: [], ado: false };
  const statements = [];

  if (copy.board) {
    const { results } = await env.DB.prepare(
      "SELECT column_key, label, sort_order FROM relay_board_columns WHERE project_id = ? AND group_by = 'section' ORDER BY sort_order"
    ).bind(template.id).all();
    for (const col of results || []) {
      statements.push(env.DB.prepare(
        "INSERT INTO relay_board_columns (id, project_id, group_by, column_key, label, sort_order) VALUES (?, ?, 'section', ?, ?, ?)"
      ).bind(crypto.randomUUID(), project.id, col.column_key, col.label, col.sort_order));
      copied.board_columns++;
    }
  }

  if (copy.tasks) {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, title, section, priority, story_points, go_live_blocking, due_constraint, accountable
       FROM asks WHERE project_id = ? AND (external_import_key IS NULL OR external_import_key NOT LIKE 'ado:%')
       ORDER BY created_at LIMIT ?`
    ).bind(template.id, MAX_TEMPLATE_TASKS).all();
    const idMap = new Map();
    const quote = `Από το πρότυπο «${template.name}»`;
    for (const t of results || []) {
      const id = crypto.randomUUID();
      idMap.set(t.id, id);
      statements.push(env.DB.prepare(
        `INSERT INTO asks (id, project_id, kind, title, owner, status, section, priority, story_points, go_live_blocking,
           due_constraint, accountable, source_quote, created_by, created_by_user_id)
         VALUES (?, ?, ?, ?, '', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, project.id, t.kind || "action", t.title, t.section, t.priority, t.story_points, t.go_live_blocking,
        t.due_constraint, t.accountable, quote, actor.email || "", actor.id));
      statements.push(env.DB.prepare("INSERT INTO events (id, ask_id, type, note) VALUES (?, ?, 'created', ?)")
        .bind(crypto.randomUUID(), id, quote.slice(0, 300)));
      copied.tasks++;
    }
    if (idMap.size) {
      const { results: deps2 } = await env.DB.prepare(
        `SELECT d.ask_id, d.depends_on_ask_id, d.source FROM relay_ask_dependencies d JOIN asks a ON a.id = d.ask_id WHERE a.project_id = ?`
      ).bind(template.id).all();
      for (const d of deps2 || []) {
        const from = idMap.get(d.ask_id), to = idMap.get(d.depends_on_ask_id);
        if (!from || !to) continue;
        statements.push(env.DB.prepare(
          "INSERT OR IGNORE INTO relay_ask_dependencies (id, ask_id, depends_on_ask_id, source, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), from, to, d.source || "template", nowIso));
        copied.dependencies++;
      }
    }
  }

  if (adoLink) {
    statements.push(env.DB.prepare(
      `INSERT INTO relay_ado_links (project_id, org, ado_project, query_id, work_item_types, exclude_states, area_path, auto_mirror,
         updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(project.id, adoLink.org, adoLink.ado_project, adoLink.query_id, adoLink.work_item_types, adoLink.exclude_states,
      adoLink.area_path, adoLink.auto_mirror, actor.id, nowIso));
    copied.ado = true;
  }

  await runBatches(env, statements);

  if (copy.members) {
    const { results } = await env.DB.prepare("SELECT email FROM relay_project_members WHERE project_id = ?").bind(template.id).all();
    for (const { email } of results || []) {
      if (email === String(actor.email || "").toLowerCase()) continue;
      if (!deps.isEmailAllowed(env, email) && !deps.isAdmin(actor)) continue;
      const insert = await env.DB.prepare(
        `INSERT OR IGNORE INTO relay_project_members (id, project_id, email, invited_by_user_id, invited_at, invite_status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      ).bind(crypto.randomUUID(), project.id, email, actor.id, nowIso).run();
      if (!insert.meta?.changes) continue;
      const sent = await deps.sendProjectInviteEmail(env, { email, project, inviterEmail: actor.email });
      await env.DB.prepare("UPDATE relay_project_members SET invite_status = ? WHERE project_id = ? AND email = ?")
        .bind(sent.ok ? "sent" : "failed", project.id, email).run();
      copied.members++;
      if (!sent.ok) copied.invite_failed.push(email);
    }
  }

  return { project, copied };
}
