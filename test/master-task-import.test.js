import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_BODY_MAX_CHARS,
  CAPTURE_BODY_SAFE_CHARS,
  DEFAULT_IMPORT_TITLE,
  buildImportCaptures,
  checkCaptureBody,
  normalizeCaptureText,
  parseMasterTaskList,
  planReminders,
  prepareCaptureBody,
  runMasterTaskImport,
  toTaskRecord,
  validateImportCapture,
} from "../src/master-task-import.js";

// ---------------------------------------------------------------- fixtures

function taskBlock(fields) {
  return Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
}

const FIXTURE_TASKS = [
  { TASK: "UAT Completion", GROUP: "UAT", OWNER: "KAFKAS Business Process Owners", STATUS: "In Progress", PRIORITY: "Critical", "DUE DATE": "2026-10-05", "GO-LIVE BLOCKING": "Yes" },
  { TASK: "Close UAT-blocking defects", GROUP: "Defects", OWNER: "Netcompany Development Team", ASSIGNEES: "Netcompany QA Team, KAFKAS IT eCommerce", STATUS: "In Progress", PRIORITY: "Critical", "DUE DATE": "2026-10-02", "GO-LIVE BLOCKING": "Yes" },
  { TASK: "Code Freeze", GROUP: "Release", OWNER: "Netcompany Project Team", STATUS: "Pending", PRIORITY: "High", "DUE DATE": "Before Code Freeze" },
  { TASK: "Regression Testing", GROUP: "Regression", OWNER: "Netcompany QA Team", STATUS: "Pending", PRIORITY: "High", "DUE DATE": "2026-10-12" },
  { TASK: "Go/No-Go decision", GROUP: "Go/No-Go", OWNER: "KAFKAS Business", ACCOUNTABLE: "Nikolaos Kourouklis", STATUS: "Pending", PRIORITY: "Critical", "DUE DATE": "2026-10-16", "GO-LIVE BLOCKING": "Yes" },
  { TASK: "F5 Production Activation", GROUP: "Cutover", OWNER: "KAFKAS Infrastructure", STATUS: "Pending", PRIORITY: "Critical", "DUE DATE": "2026-10-18" },
  { TASK: "Post-Go-Live Monitoring", GROUP: "HyperCare", OWNER: "KAFKAS IT Operations", STATUS: "Pending", PRIORITY: "High", "DUE DATE": "During HyperCare" },
  { TASK: "Security findings re-test", GROUP: "Security", OWNER: "KAFKAS Security Team", STATUS: "Completed", PRIORITY: "High", "DUE DATE": "2026-09-01", REMINDERS: "Evidence review only" },
  { TASK: "Security Sign-Off", GROUP: "Security", OWNER: "KAFKAS Security Team", STATUS: "Pending Decision", PRIORITY: "Critical", "DUE DATE": "2026-09-10", "GO-LIVE BLOCKING": "Yes" },
  { TASK: "Sales categories and filters review", GROUP: "Sales Categories and Filters", OWNER: "KAFKAS Marketing Team", STATUS: "Pending ETA", PRIORITY: "Medium", "DUE DATE": "Ongoing", NOTES: "Ελληνικά: έλεγχος φίλτρων «κατηγοριών» και τιμών €" },
  { TASK: "Release 1 wishlist", GROUP: "Release 1 Backlog", OWNER: "KAFKAS Business", STATUS: "Release 1", PRIORITY: "Low", "DUE DATE": "To be confirmed" },
];

const FIXTURE_TEXT = FIXTURE_TASKS.map(taskBlock).join("\n\n");
const NOW = new Date("2026-09-17T10:00:00Z"); // Πέμπτη, 13:00 Αθήνα

function bigTask(index, size) {
  return taskBlock({
    TASK: `Data readiness check ${index}`,
    GROUP: "Data Readiness",
    OWNER: "KAFKAS Data/Product/Pricing owners",
    STATUS: "Pending",
    PRIORITY: "Medium",
    "DUE DATE": "2026-10-10",
    NOTES: `Ελέγχος δεδομένων ${index} — `.repeat(Math.ceil(size / 25)).slice(0, size),
  });
}

function createMemoryStore({ failOnCaptureTitle } = {}) {
  const state = { captures: new Map(), tasks: new Map(), dependencies: new Set(), reminders: new Map(), policies: new Map(), flushes: 0 };
  let seq = 0;
  let pending = [];
  const store = {
    state,
    async upsertCapture({ title, body }) {
      if (failOnCaptureTitle && title.includes(failOnCaptureTitle)) throw new Error("simulated storage failure");
      if (state.captures.has(title)) {
        state.captures.get(title).body = body;
        return { id: state.captures.get(title).id, created: false };
      }
      const id = `capture-${++seq}`;
      pending.push(() => state.captures.set(title, { id, body }));
      state.captures.set(title, { id, body });
      return { id, created: true };
    },
    async findTaskByKey(_projectId, key) {
      return state.tasks.get(key) || null;
    },
    async insertTask({ record, snapshot }) {
      const id = `task-${++seq}`;
      state.tasks.set(record.importKey, { ...structuredClone(record), id, importSnapshot: snapshot });
      return id;
    },
    async updateTask({ id, updates, snapshot }) {
      for (const task of state.tasks.values()) {
        if (task.id === id) {
          Object.assign(task, structuredClone(updates));
          task.importSnapshot = snapshot;
        }
      }
    },
    async addDependency({ askId, dependsOnAskId }) {
      const key = `${askId}->${dependsOnAskId}`;
      if (state.dependencies.has(key)) return false;
      state.dependencies.add(key);
      return true;
    },
    async upsertReminder(reminder) {
      if (state.reminders.has(reminder.dedupeKey)) return false;
      state.reminders.set(reminder.dedupeKey, { ...reminder, status: "pending" });
      return true;
    },
    async cancelPendingReminders({ askId }) {
      let count = 0;
      for (const reminder of state.reminders.values()) {
        if (reminder.askId === askId && reminder.status === "pending") {
          reminder.status = "cancelled";
          count++;
        }
      }
      return count;
    },
    async setReminderPolicy({ askId, policy }) {
      state.policies.set(askId, policy);
    },
    async flush() {
      state.flushes++;
      pending = [];
    },
    discard() {
      pending = [];
    },
  };
  return store;
}

const findTask = (store, title) => [...store.state.tasks.values()].find((task) => task.title === title);

// ---------------------------------------------------------------- 1-15 validation / normalization / split

test("1. empty string body is rejected and falls back", () => {
  assert.equal(checkCaptureBody("").ok, false);
  assert.deepEqual(prepareCaptureBody(""), { body: DEFAULT_IMPORT_TITLE, usedFallback: true });
});

test("2. whitespace-only body is empty after normalization", () => {
  assert.equal(normalizeCaptureText(" \n\t  \r\n "), "");
  assert.equal(checkCaptureBody("   \n ").ok, false);
});

test('3. <br aria-hidden="true"> is not a meaningful body', () => {
  assert.equal(normalizeCaptureText('<br aria-hidden="true">'), "");
  const prepared = prepareCaptureBody('<br aria-hidden="true">');
  assert.equal(prepared.usedFallback, true);
  assert.equal(prepared.body, DEFAULT_IMPORT_TITLE);
  assert.equal(checkCaptureBody(prepared.body).ok, true);
});

test("4. body with only HTML tags is empty", () => {
  assert.equal(normalizeCaptureText("<div><p></p><span> </span><br/><!-- x --></div><style>p{}</style>"), "");
});

test("5. plain text under 20.000 characters is valid and unchanged", () => {
  const body = "TASK: Something\nOWNER: KAFKAS IT eCommerce";
  assert.equal(normalizeCaptureText(body), body);
  assert.equal(checkCaptureBody(body).ok, true);
});

test("6. exactly 20.000 characters passes the hard limit but not the 19.500 safety limit", () => {
  const body = "a".repeat(CAPTURE_BODY_MAX_CHARS);
  const result = checkCaptureBody(body, { safeChars: CAPTURE_BODY_MAX_CHARS });
  assert.equal(result.ok, true);
  assert.equal(checkCaptureBody(body).ok, false);
  assert.match(checkCaptureBody(body).errors[0], /safety limit 19500/);
});

test("7. more than 20.000 characters is rejected (no silent truncation)", () => {
  const result = checkCaptureBody("a".repeat(CAPTURE_BODY_MAX_CHARS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.length, 20001);
  assert.match(result.errors[0], /exceeds 20000/);
});

test("8-11. structured split: chunks <= 19.500, no task split, every chunk has TASK blocks and is non-empty", () => {
  const text = Array.from({ length: 12 }, (_, i) => bigTask(i + 1, 4000)).join("\n\n");
  const parsed = parseMasterTaskList(text);
  assert.equal(parsed.tasks.length, 12);
  const { captures, errors } = buildImportCaptures(parsed.tasks, { importBatchId: "batch-test" });
  assert.deepEqual(errors, []);
  assert.ok(captures.length > 1, "expected multiple captures");
  const seen = [];
  for (const capture of captures) {
    assert.ok(capture.body.length <= CAPTURE_BODY_SAFE_CHARS, `part ${capture.part} is ${capture.body.length}`);
    assert.ok(capture.body.trim().length > 0);
    assert.ok(/^TASK:/m.test(capture.body));
    assert.equal(validateImportCapture(capture).ok, true);
    const tasks = parseMasterTaskList(capture.body).tasks;
    assert.ok(tasks.length >= 1);
    for (const task of tasks) {
      const original = parsed.tasks.find((t) => t.fields.title === task.fields.title);
      assert.equal(task.raw, original.raw, "task block must be complete in one capture");
      seen.push(task.fields.title);
    }
    assert.match(capture.body, new RegExp(`^PROJECT: KAFKAS B2B Public Go-Live\\nTARGET GO-LIVE: 2026-10-18\\nIMPORT BATCH ID: batch-test\\nPART: ${capture.part}/${captures.length}\\nSOURCE TYPE: Master Task List\\nDO NOT MERGE SIMILAR TASKS: YES`));
    assert.equal(capture.title, `KAFKAS B2B Go-Live 18-10 - Master Tasks - Part ${capture.part} of ${captures.length} - ${capture.groupLabel}`);
  }
  assert.equal(seen.length, 12, "every task appears exactly once");
});

test("8b. a single task larger than the budget is reported, not truncated", () => {
  const parsed = parseMasterTaskList(bigTask(1, 25000));
  const { captures, errors } = buildImportCaptures(parsed.tasks, { importBatchId: "b" });
  assert.equal(captures.length, 0);
  assert.equal(errors[0].type, "task_too_large");
});

test("12. Greek and English Unicode content stays intact", () => {
  const text = "TASK: Έλεγχος «κατηγοριών» — test €\nNOTES: Ελληνικά & English ✓";
  const parsed = parseMasterTaskList(text);
  assert.equal(parsed.tasks[0].fields.title, "Έλεγχος «κατηγοριών» — test €");
  assert.equal(parsed.tasks[0].fields.notes, "Ελληνικά & English ✓");
});

test("13. CRLF line endings are normalized", () => {
  assert.equal(normalizeCaptureText("TASK: A\r\nOWNER: B\rNOTES: C"), "TASK: A\nOWNER: B\nNOTES: C");
});

test("14. HTML entities and Outlook/Teams markup are handled", () => {
  const html = "<div>TASK: R&amp;D review&nbsp;&#8212; &lt;prod&gt;</div><div>OWNER: KAFKAS&#x20;IT</div><o:p></o:p><script>evil()</script>";
  assert.equal(normalizeCaptureText(html), "TASK: R&D review — <prod>\nOWNER: KAFKAS IT");
});

test("15. fallback uses a meaningful plain-text title first", () => {
  assert.deepEqual(prepareCaptureBody("<br>", { title: "<b>Go-Live</b> tasks\nsecond" }), { body: "Go-Live tasks", usedFallback: true });
});

// ---------------------------------------------------------------- 16-25 import engine

test("16-17. re-import is idempotent: no duplicate tasks, reminders or dependencies", async () => {
  const store = createMemoryStore();
  const first = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  assert.equal(first.status, "Success");
  const taskCount = store.state.tasks.size;
  const reminderCount = store.state.reminders.size;
  const dependencyCount = store.state.dependencies.size;
  assert.ok(reminderCount > 0 && dependencyCount > 0);

  const second = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  assert.equal(store.state.tasks.size, taskCount);
  assert.equal(store.state.reminders.size, reminderCount);
  assert.equal(store.state.dependencies.size, dependencyCount);
  assert.equal(second.tasks.created, 0);
  assert.equal(second.tasks.updated, 0);
  assert.equal(second.tasks.skipped, taskCount);
  assert.equal(second.reminders.created, 0);
  assert.equal(second.dependencies.created, 0);
  assert.equal(second.importBatchId, first.importBatchId);
});

test("16b. user edits are kept and completed status is never reset on re-import", async () => {
  const store = createMemoryStore();
  await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  const codeFreeze = findTask(store, "Code Freeze");
  codeFreeze.owner = "Edited by user";
  codeFreeze.status = "done";
  const changed = FIXTURE_TEXT.replace("OWNER: Netcompany Project Team", "OWNER: Netcompany DevOps").replace("TASK: Code Freeze\nGROUP: Release\nOWNER: Netcompany DevOps\nSTATUS: Pending", "TASK: Code Freeze\nGROUP: Release\nOWNER: Netcompany DevOps\nSTATUS: In Progress");
  const summary = await runMasterTaskImport({ text: changed, projectId: "p1", store, now: NOW });
  assert.equal(findTask(store, "Code Freeze").owner, "Edited by user");
  assert.equal(findTask(store, "Code Freeze").status, "done");
  assert.ok(summary.warnings.some((w) => /Code Freeze: kept user changes/.test(w)));
});

test("18. dependencies are resolved after task creation", async () => {
  const store = createMemoryStore();
  const summary = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  const id = (title) => findTask(store, title).id;
  const deps = store.state.dependencies;
  assert.ok(deps.has(`${id("UAT Completion")}->${id("Close UAT-blocking defects")}`));
  assert.ok(deps.has(`${id("Regression Testing")}->${id("Code Freeze")}`));
  assert.ok(deps.has(`${id("F5 Production Activation")}->${id("Go/No-Go decision")}`));
  assert.ok(deps.has(`${id("Post-Go-Live Monitoring")}->${id("F5 Production Activation")}`));
  assert.ok(deps.has(`${id("Security Sign-Off")}->${id("Security findings re-test")}`));
  assert.ok(deps.has(`${id("Go/No-Go decision")}->${id("Regression Testing")}`));
  assert.equal(summary.dependencies.created, deps.size);
});

test("19. unresolved owners are reported and tasks stay active", async () => {
  const store = createMemoryStore();
  const summary = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  assert.ok(summary.unresolvedOwners.includes("KAFKAS Business"));
  assert.ok(summary.unresolvedOwners.includes("Nikolaos Kourouklis"));
  const task = findTask(store, "Go/No-Go decision");
  assert.equal(task.owner, "KAFKAS Business");
  assert.equal(task.details.assignmentResolutionRequired, true);
  assert.equal(task.status, "open");
});

test("20. past due date is marked overdue without changing the due date", async () => {
  const store = createMemoryStore();
  await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  const task = findTask(store, "Security Sign-Off");
  assert.equal(task.dueDate, "2026-09-10");
  assert.equal(task.details.sourceOverdue, true);
  const textual = findTask(store, "Code Freeze");
  assert.equal(textual.dueDate, "");
  assert.equal(textual.dueConstraint, "Before Code Freeze");
});

test("21. completed task receives no daily operational reminder", () => {
  const block = parseMasterTaskList(taskBlock(FIXTURE_TASKS[7])).tasks[0];
  const record = toTaskRecord(block, { importBatchId: "b", today: "2026-09-17" });
  record.importKey = "k";
  const plan = planReminders(record, { now: NOW });
  assert.equal(record.status, "done");
  assert.deepEqual(plan.reminders, []);
  assert.ok(plan.policy.some((line) => /evidence review/.test(line)));
});

test("22. waiting tasks get the correct reminder policy", () => {
  const record = (fields) => ({ ...toTaskRecord(parseMasterTaskList(taskBlock(fields)).tasks[0], { importBatchId: "b", today: "2026-09-17" }), importKey: "k" });
  const external = planReminders(record({ TASK: "Vendor ETA", STATUS: "Pending ETA", PRIORITY: "Medium", "DUE DATE": "Ongoing" }), { now: NOW });
  assert.deepEqual(external.reminders.map((r) => r.recurrence), ["every-2-workdays-0900"]);
  assert.equal(external.reminders[0].remindAt, "2026-09-18T06:00:00.000Z"); // Παρασκευή 09:00 Αθήνα
  const decision = planReminders(record({ TASK: "Scope decision", STATUS: "Pending Decision", PRIORITY: "Medium" }), { now: NOW });
  assert.deepEqual(decision.reminders.map((r) => r.recurrence), ["workday-daily-0900"]);
  const goNoGo = planReminders(record(FIXTURE_TASKS[4]), { now: NOW });
  const times = goNoGo.reminders.map((r) => r.remindAt);
  assert.ok(times.includes("2026-10-15T06:00:00.000Z") && times.includes("2026-10-16T06:00:00.000Z"));
  const f5 = planReminders(record(FIXTURE_TASKS[5]), { now: NOW });
  assert.ok(f5.reminders.some((r) => r.remindAt === "2026-10-18T04:00:00.000Z")); // 07:00 Αθήνα
  for (const plan of [external, decision, goNoGo, f5]) {
    for (const reminder of plan.reminders) assert.ok(new Date(reminder.remindAt) >= NOW, "no reminder in the past");
  }
});

test("22b. past computed reminders become one immediate reminder plus future ones", () => {
  const block = parseMasterTaskList(taskBlock({ TASK: "Soon", PRIORITY: "Critical", STATUS: "Pending", "DUE DATE": "2026-09-19" })).tasks[0];
  const plan = planReminders({ ...toTaskRecord(block, { importBatchId: "b", today: "2026-09-17" }), importKey: "k" }, { now: NOW });
  const immediate = plan.reminders.filter((r) => r.rule.startsWith("immediate"));
  assert.equal(immediate.length, 1);
  assert.ok(plan.reminders.some((r) => r.remindAt === "2026-09-18T06:00:00.000Z"));
  assert.ok(plan.reminders.some((r) => r.remindAt === "2026-09-19T06:00:00.000Z"));
});

test("23. production operational account task is created as Waiting", async () => {
  const store = createMemoryStore();
  const summary = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  const task = findTask(store, "Create the new Production technical and operational account");
  assert.ok(task, "required task added");
  assert.equal(task.sourceStatus, "Waiting for Netcompany Instructions");
  assert.equal(task.details.statusCategory, "waiting");
  assert.equal(task.status, "open");
  assert.equal(task.priority, "critical");
  assert.equal(task.goLiveBlocking, "potential");
  assert.equal(task.dueDate, "");
  assert.equal(task.dueConstraint, "To be confirmed immediately when the email is received");
  assert.equal(task.accountable, "Nikolaos Kourouklis");
  assert.ok(summary.warnings.some((w) => /Required task/.test(w)));
  const reminders = [...store.state.reminders.values()].filter((r) => r.askId === task.id);
  assert.deepEqual(reminders.map((r) => r.recurrence), ["workday-daily-0900"]);
});

test("24. partial failure is reported and the failed part can be retried idempotently", async () => {
  const text = [FIXTURE_TEXT, ...Array.from({ length: 6 }, (_, i) => bigTask(i + 1, 4000))].join("\n\n");
  const failing = createMemoryStore({ failOnCaptureTitle: "Data Readiness" });
  const partial = await runMasterTaskImport({ text, projectId: "p1", store: failing, now: NOW });
  assert.equal(partial.status, "Partial Failure");
  const failedParts = partial.parts.filter((p) => p.status === "failed");
  assert.ok(failedParts.length >= 1);
  assert.ok(partial.validationErrors.some((e) => e.part === failedParts[0].part && e.batchId === partial.importBatchId && e.length > 0));
  assert.equal(findTask(failing, "Data readiness check 1"), undefined);

  // Retry με το ίδιο store (π.χ. μετά από προσωρινό σφάλμα): συμπληρώνει μόνο ό,τι έλειπε.
  const before = failing.state.tasks.size;
  const recovered = createMemoryStore();
  recovered.state.tasks = failing.state.tasks;
  recovered.state.captures = failing.state.captures;
  recovered.state.reminders = failing.state.reminders;
  recovered.state.dependencies = failing.state.dependencies;
  const retry = await runMasterTaskImport({ text, projectId: "p1", store: recovered, now: NOW });
  assert.equal(retry.status, "Success");
  assert.equal(retry.importBatchId, partial.importBatchId);
  assert.equal(retry.tasks.created, recovered.state.tasks.size - before);
  assert.ok(findTask(recovered, "Data readiness check 1"));
});

test("25. import summary counts are accurate", async () => {
  const store = createMemoryStore();
  const summary = await runMasterTaskImport({ text: FIXTURE_TEXT, projectId: "p1", store, now: NOW });
  assert.equal(summary.tasks.parsed, FIXTURE_TASKS.length + 1); // + required task
  assert.equal(summary.tasks.created, store.state.tasks.size);
  assert.equal(summary.captures.total, summary.parts.length);
  assert.equal(summary.captures.created, store.state.captures.size);
  assert.equal(summary.captures.rejected, 0);
  assert.equal(summary.reminders.created, store.state.reminders.size);
  assert.equal(summary.dependencies.created, store.state.dependencies.size);
  assert.deepEqual(summary.validationErrors, []);
  assert.ok(summary.parts.every((p) => p.length <= CAPTURE_BODY_SAFE_CHARS && p.status === "ok"));
});

test("status and priority normalization keeps source values", () => {
  const record = (status, priority) => toTaskRecord(parseMasterTaskList(taskBlock({ TASK: "x", STATUS: status, PRIORITY: priority })).tasks[0], { importBatchId: "b", today: "2026-09-17" });
  assert.equal(record("Completed", "Critical").status, "done");
  assert.equal(record("Temporary Flow Agreed / Documentation Pending", "High").status, "accepted");
  assert.equal(record("Blocked", "Low").statusCategory, "blocked");
  assert.equal(record("Release 1", "Medium").statusCategory, "backlog");
  assert.equal(record("Confirmation Required", "Medium").statusCategory, "review");
  const critical = record("Pending", "Critical");
  assert.equal(critical.priority, "critical");
  assert.equal(critical.sourcePriority, "Critical");
  const unknown = record("Something new", "Whatever");
  assert.equal(unknown.status, "open");
  assert.equal(unknown.sourceStatus, "Something new");
  assert.equal(unknown.warnings.length, 2);
});

test("similar titles in the same group are not merged", async () => {
  const text = [taskBlock({ TASK: "Smoke test", GROUP: "Smoke Testing", STATUS: "Pending" }), taskBlock({ TASK: "Smoke test", GROUP: "Smoke Testing", STATUS: "Completed" })].join("\n\n");
  const store = createMemoryStore();
  const summary = await runMasterTaskImport({ text, projectId: "p1", store, now: NOW });
  const smoke = [...store.state.tasks.values()].filter((t) => t.title === "Smoke test");
  assert.equal(smoke.length, 2);
  assert.ok(summary.warnings.some((w) => /Duplicate task title/.test(w)));
});
