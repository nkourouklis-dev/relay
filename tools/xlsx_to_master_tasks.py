"""Μετατρέπει τα δύο workbooks του Go-Live (Production Smoke Test + PRD Integrations Test Matrix)
στη μορφή "TASK:" που διαβάζει ο υπάρχων importer του Relay (Import Master Task List).

Χρήση:  python tools/xlsx_to_master_tasks.py
Είσοδος:  data/KAFKAS_B2B_Production_Smoke_Test.xlsx, data/PRD_GoLive_Integrations_TestMatrix.xlsx
Έξοδος:   data/kafkas-b2b-golive-tests-tasks.txt  (ο φάκελος data/ είναι gitignored)

Δεν εφευρίσκει τιμές: ό,τι λείπει από τα αρχεία (υπεύθυνος, ημερομηνίες) μένει κενό.
"""
import os
import re
import sys

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SMOKE = os.path.join(DATA, "KAFKAS_B2B_Production_Smoke_Test.xlsx")
MATRIX = os.path.join(DATA, "PRD_GoLive_Integrations_TestMatrix.xlsx")
OUT = os.path.join(DATA, "kafkas-b2b-golive-tests-tasks.txt")


def flat(value):
    """Μία γραμμή: ο importer θεωρεί συνέχεια πεδίου μόνο γραμμές χωρίς «ΠΕΔΙΟ:»."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def rows(ws, header_row_text):
    """Επιστρέφει (headers, data_rows) ξεκινώντας από τη γραμμή κεφαλίδας που ξεκινά με header_row_text."""
    all_rows = list(ws.iter_rows(values_only=True))
    for i, row in enumerate(all_rows):
        if row and flat(row[0]) == header_row_text:
            headers = [flat(c) for c in row]
            return headers, all_rows[i + 1:]
    raise SystemExit(f"Δεν βρέθηκε κεφαλίδα '{header_row_text}' στο sheet {ws.title}")


def record(row, headers):
    return {h: flat(v) for h, v in zip(headers, row) if h}


class Task:
    def __init__(self, title, group):
        self.fields = [("TASK", title), ("GROUP", group)]

    def add(self, key, value):
        value = flat(value)
        if value:
            self.fields.append((key, value))

    def text(self):
        return "\n".join(f"{k}: {v}" for k, v in self.fields)


def priority_smoke(p):
    # P1 = blocking (πρέπει να περάσει πριν ανοίξει το DNS), P2 = συχνό αλλά μη blocking.
    return ("Critical", "Yes") if p == "P1" else ("High", "No")


def priority_matrix(p):
    # Must = blocks go-live, Should = μπορεί να μείνει ανοιχτό με απόφαση του business owner.
    return ("Critical", "Yes") if p == "Must" else ("Medium", "No")


def smoke_tasks():
    wb = openpyxl.load_workbook(SMOKE, data_only=True)
    tasks = []

    headers, data = rows(wb["Execution"], "#")
    section = ""
    for row in data:
        first = flat(row[0])
        if not first:
            continue
        if re.match(r"^[A-Z]\.\s", first):  # "A. Core spine (blocking)"
            section = first
            continue
        r = record(row, headers)
        if not r.get("Flow ID"):
            continue
        prio, blocking = priority_smoke(r.get("Priority", ""))
        t = Task(f"PROD Smoke {r['Flow ID']} - {r['Flow']}", f"PROD Smoke Test - {section}")
        t.add("STATUS", "Not started")
        t.add("PRIORITY", prio)
        t.add("GO-LIVE BLOCKING", blocking)
        t.add("DUE DATE", "Before DNS is opened (public go-live)" if r.get("Priority") == "P1" else "Same day as the P1 flows")
        t.add("ACCEPTANCE CRITERIA", f"{r.get('What to execute', '')} Pass recorded with one screenshot at the decisive step. Defects: ADO with PROD prefix, ID in the Defect ID column.")
        t.add("DEPENDENCIES", r.get("Production data dependency", ""))
        t.add("NOTES", f"Why critical: {r.get('Why it is critical', '')}" + (f" | Source comment: {r['Comments / order no.']}" if r.get("Comments / order no.") else ""))
        t.add("REFERENCE", f"Source UAT TCs: {r.get('Source TCs', '')}")
        tasks.append(t)

    headers, data = rows(wb["Cross-cutting checks"], "Ref")
    for row in data:
        r = record(row, headers)
        if not r.get("Ref"):
            continue
        t = Task(f"PROD Smoke {r['Ref']} - {r['Check']}", "PROD Smoke Test - Cross-cutting checks")
        t.add("STATUS", "Not started")
        t.add("DUE DATE", "Before DNS is opened (public go-live)")
        t.add("ACCEPTANCE CRITERIA", r.get("What must be true", ""))
        t.add("NOTES", f"Recorded while the flows run: {r.get('When to record', '')}" + (f" | Source comment: {r['Comments']}" if r.get("Comments") else ""))
        tasks.append(t)
    return tasks


def matrix_tasks():
    wb = openpyxl.load_workbook(MATRIX, data_only=True)
    tasks = []

    pf_by_integration = {}
    headers, data = rows(wb["Pre-flight"], "ID")
    pre = []
    for row in data:
        r = record(row, headers)
        if re.match(r"^PF-\d+$", r.get("ID", "")):
            pre.append(r)
            pf_by_integration.setdefault(r["Integration"], []).append(r["ID"])

    for r in pre:
        t = Task(f"{r['ID']} - {r['Check']}", f"PRD Pre-flight - {r['Integration']}")
        t.add("OWNER", r.get("Owner", ""))
        t.add("STATUS", r.get("Status", "") or "Not started")
        t.add("PRIORITY", "Critical")
        t.add("GO-LIVE BLOCKING", "Yes")
        t.add("DUE DATE", "Before the PRD test window")
        t.add("ACCEPTANCE CRITERIA", f"Done (or agreed N/A). Where / setting: {r.get('Where / setting', '')}")
        t.add("NOTES", f"Why it matters: {r.get('Why it matters', '')}" + (f" | Source notes: {r['Notes']}" if r.get("Notes") else ""))
        tasks.append(t)

    headers, data = rows(wb["Test Cases"], "ID")
    for row in data:
        r = record(row, headers)
        if not re.match(r"^[A-Z0-9]+-\d+$", r.get("ID", "")):
            continue
        prio, blocking = priority_matrix(r.get("Priority", ""))
        pfs = pf_by_integration.get(r["Integration"], [])
        t = Task(f"{r['ID']} - {r['Test case']}", f"PRD Integration Tests - {r['Integration']}")
        t.add("OWNER", r.get("Owner", ""))
        t.add("STATUS", "Not started" if r.get("Result", "").lower() in ("", "not run") else r["Result"])
        t.add("PRIORITY", prio)
        t.add("GO-LIVE BLOCKING", blocking)
        t.add("DUE DATE", "During the PRD test window")
        t.add("DEPENDENCIES", f"Pre-flight checks for {r['Integration']}: {', '.join(pfs)}" if pfs else "")
        t.add("ACCEPTANCE CRITERIA", r.get("Expected result", ""))
        cleanup = r.get("Cleanup", "")
        t.add("NOTES", f"Flow: {r.get('Flow', '')} | How to test: {r.get('How to test', '')} | Evidence: {r.get('Evidence to record', '')}"
                       + (f" | Cleanup: {cleanup}" if cleanup and cleanup != "—" else ""))
        tasks.append(t)
    return tasks


def main():
    for path in (SMOKE, MATRIX):
        if not os.path.exists(path):
            sys.exit(f"Λείπει το αρχείο: {path}")
    tasks = smoke_tasks() + matrix_tasks()
    header = (
        "# KAFKAS B2B Go-Live - tests and pre-flight tasks (generated by tools/xlsx_to_master_tasks.py)\n"
        "# Source: KAFKAS_B2B_Production_Smoke_Test.xlsx + PRD_GoLive_Integrations_TestMatrix.xlsx\n"
        "# Import: Relay -> project -> Import Master Task List. Safe to re-run (idempotent).\n\n"
    )
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(header + "\n\n".join(t.text() for t in tasks) + "\n")

    groups = {}
    for t in tasks:
        groups[dict(t.fields)["GROUP"]] = groups.get(dict(t.fields)["GROUP"], 0) + 1
    print(f"{len(tasks)} tasks -> {OUT}")
    for g, n in groups.items():
        print(f"  {n:3d}  {g}")
    owners = sorted({dict(t.fields).get("OWNER", "") for t in tasks} - {""})
    print("Owners (text, δεν αντιστοιχίζονται σε emails):")
    for o in owners:
        print("  -", o)
    print(f"Tasks without owner: {sum(1 for t in tasks if 'OWNER' not in dict(t.fields))}")


if __name__ == "__main__":
    main()
