# Relay — Οδηγός Product Owner

*Snapshot κατάστασης: 6 Σεπτεμβρίου 2026, βάσει του κώδικα στο `relay.zip`. Αυτό το αρχείο είναι η "πηγή αλήθειας" για το πού βρίσκεται το προϊόν — ενημέρωσέ το (ή ζήτα μου να το ενημερώσω) μετά από κάθε ουσιαστική αλλαγή.*

---

## 1. One-line pitch

Project tracking που ζει μόνο του: στέλνεις email ή κάνεις paste κείμενο, και το Relay μετατρέπει τις δεσμεύσεις σε tracked λίστα «ποιος-χρωστάει-τι-μέχρι-πότε», με dashboard, AI insights και exports.

## 2. Στόχος χρήστη (target user)

Solo PM ή μικρή ομάδα που θέλει accountability tracking χωρίς να αλλάξει τον τρόπο που ήδη επικοινωνεί (email/chat) — δεν χρειάζεται manual logging σε board.

---

## 3. Λειτουργική κατάσταση σήμερα (τι δουλεύει live)

| Δυνατότητα | Κατάσταση | Σημείωση |
|---|---|---|
| Capture-by-email | ✅ Live | Cloudflare Email Routing → Worker → postal-mime → AI extraction |
| Paste-to-extract με preview | ✅ Live | `/api/capture/preview` → επιβεβαίωση owner → `/api/capture/commit` |
| AI εξαγωγή asks | ✅ Live | Workers AI (llama-3.3-70b), με heuristic fallback χωρίς AI binding |
| Dashboard + charts | ✅ Live | Chart.js: donut status + bar ανά owner |
| AI Executive Summary | ✅ Live | Με weekly filter option |
| AI Insights (overdue/blocked/unassigned) | ✅ Live | |
| Excel export | ✅ Live | 4-sheet `.xlsx` μέσω SheetJS |
| PPT export | ✅ Live | 5-slide `.pptx` μέσω PptxGenJS |
| Login (magic link, email-based) | ✅ Live | Better Auth + Resend |
| Route protection (auth guards) | ✅ Live | Read/write στα asks/projects/dashboard απαιτούν session |
| Περιορισμός login σε `@kafkas.gr` (+ ρητές εξαιρέσεις `ALLOWED_EMAILS`) | 🟡 Υλοποιήθηκε — εκκρεμεί deploy | Φάση 1 (2026-09-17) |
| Ρόλοι `admin` / `user` | 🟡 Υλοποιήθηκε — εκκρεμεί deploy | Φάση 1. Admin ορίζεται μόνο με SQL (`bootstrap_admin.sql`) |
| Απομόνωση δεδομένων ανά δημιουργό (server-side) | 🟡 Υλοποιήθηκε — εκκρεμεί deploy | Φάση 1. User βλέπει/αλλάζει μόνο ό,τι δημιούργησε· admin τα πάντα. Αντικαθιστά το παλιό «ownership lock» με email |
| Overdue auto-detection | ✅ Live | Daily cron 08:00 UTC |
| Owner = πραγματικός λογαριασμός (όχι free text) | ❌ Δεν έχει γίνει | Phase D του auth plan |
| Claim flow για legacy bare-name owners | ❌ Δεν έχει γίνει | Phase D |
| Multi-user / shared projects | ❌ Δεν έχει αποφασιστεί | Phase E — **χρειάζεται δική σου απόφαση** |
| `project_members` table | ❌ Δεν υπάρχει | Εξαρτάται από Phase E |

---

## 4. Το πρόβλημα ταυτότητας (identity problem) — γιατί έχει σημασία

Το πεδίο `owner` στα asks είναι **ελεύθερο κείμενο**. Αυτό σημαίνει ότι το ίδιο άτομο μπορεί να εμφανίζεται ως `Κώστας` σε ένα ask και ως `kostas@company.com` σε άλλο — και το dashboard τα μετράει ως δύο διαφορετικούς ανθρώπους. Η λύση (login με email ως ενιαία ταυτότητα) έχει ήδη υλοποιηθεί σε επίπεδο **infrastructure** (Phases A–C), αλλά όχι ακόμα στο **UX** (Phase D — owner picker + claim flow).

**Τι μένει, συγκεκριμένα:**
1. Το πεδίο "Owner" στη φόρμα δημιουργίας ask να γίνει επιλογέας γνωστών χρηστών (dropdown by email) αντί για ελεύθερο πεδίο.
2. Μια απλή οθόνη "claim this ask" ώστε κάποιος που συνδέεται για πρώτη φορά να μπορεί να διεκδικήσει παλιά asks με το όνομά του.

---

## 4α. Φάση 1 — Ρόλοι & δικαιώματα (τι ισχύει μετά το deploy)

**Ποιος μπαίνει:** μόνο emails `@kafkas.gr` και όσα emails είναι ρητά στη λίστα `ALLOWED_EMAILS` (π.χ. προσωπικό email όσο δεν υπάρχει εταιρικό). Η λίστα είναι Cloudflare secret (`npx wrangler secret put ALLOWED_EMAILS`), όχι στο repo. Όλοι οι άλλοι παίρνουν μήνυμα «Η σύνδεση επιτρέπεται μόνο με εταιρικό email @kafkas.gr.» και δεν στέλνεται link. Αν αφαιρεθεί κάποιο email από τη λίστα, το υπάρχον session του σταματά να λειτουργεί.

**Ρόλοι:**
| Ρόλος | Τι βλέπει / αλλάζει | Πώς αποκτάται |
|---|---|---|
| `user` (default) | Μόνο projects και asks που **δημιούργησε ο ίδιος** | Αυτόματα στο πρώτο login |
| `admin` | Τα πάντα, μαζί με τα legacy δεδομένα | Μόνο χειροκίνητα με SQL (`bootstrap_admin.sql`) — δεν υπάρχει τρόπος από το UI ή το API |

**Τι σημαίνει «δικό μου»:** ο **δημιουργός** (`created_by_user_id`), όχι ο owner. Αν ένα ask ανατεθεί (owner) σε κάποιον αλλά το δημιούργησε άλλος, αυτός που το ανέλαβε **δεν** το βλέπει. Ο owner παραμένει ελεύθερο κείμενο (βλ. §4).

**Legacy δεδομένα:**
- Asks όπου το παλιό `created_by` (email) ταιριάζει με λογαριασμό → συνδέθηκαν αυτόματα σε αυτόν.
- Όλα τα υπόλοιπα asks και **όλα τα projects που υπήρχαν πριν** (δεν είχαν πληροφορία δημιουργού) → χωρίς δημιουργό → **ορατά μόνο σε admin**.
- Αν αργότερα συνδεθεί για πρώτη φορά κάποιος που έχει παλιά asks με το email του, ξανατρέχει το `migrate_phase1_backfill_created_by.sql`.

**Γνωστές συνέπειες:**
- Asks που έρχονται με **email** ή `/api/ingest` δεν έχουν δημιουργό → τα βλέπει **μόνο ο admin** (αυτά τα routes δεν άλλαξαν στη Φάση 1).
- Ask που δημιουργεί ο admin μέσα σε project ενός user **δεν** εμφανίζεται στον user.
- Όταν ένας user διαγράφει δικό του project, διαγράφονται όλα τα asks του, ακόμα κι αν κάποια τα δημιούργησε ο admin.
- Νέος user ξεκινά χωρίς κανένα project — πρέπει να δημιουργήσει δικό του.

---

## 5. Ανοιχτές αποφάσεις που χρειάζονται εσένα (όχι developer/AI)

1. **Backfill mapping**: ποια από τα `Κώστας` / `Ελένη` / `Άννα` αντιστοιχούν σε ήδη γνωστά emails, και ποια πρέπει να περιμένουν self-service claim.
2. **Single-owner vs multi-user projects (Phase E)**: ένα project ανήκει μόνο σε σένα, ή vendor/PM/συνάδελφοι μπαίνουν με δικό τους login στο *ίδιο* project; Αυτό καθορίζει το μέγεθος του Phase D UI.
3. **Resend vs εναλλακτικός email provider**: αν θες να αλλάξεις από Resend σε κάτι άλλο (π.χ. Postmark).
4. Αν θες να αφαιρεθεί εντελώς το legacy free-text owner πεδίο μόλις είναι έτοιμο το picker, ή να συνυπάρχουν για μεταβατική περίοδο.

---

## 6. Roadmap (σειρά προτεραιότητας)

1. **Phase D** — Owner picker + claim flow (λύνει το βασικό πρόβλημα ταυτότητας).
2. **Phase E** — Απόφαση + υλοποίηση multi-user projects (αν χρειάζεται).
3. **Phase F** — Καθαρισμός: αφαίρεση legacy free-text owner UI, ενημέρωση README με το `RESEND_API_KEY` requirement.
4. Πιθανές μελλοντικές επεκτάσεις (ήδη αναφερόμενες στο README): **R2** για attachments, **Vectorize** για dedupe εγγραφών.

---

## 7. Κανόνες δουλειάς (πώς προχωράμε ασφαλώς)

Αυτοί οι κανόνες προϋπάρχουν στο repo (`AGENTS.md`) και ισχύουν και σε εμένα όταν δουλεύουμε μαζί:

- Δουλεύουμε **μία φάση τη φορά** — όχι συνδυασμός π.χ. Phase D + Phase E σε ένα βήμα.
- Πριν ξεκινήσουμε μια φάση, σου λέω ρητά τι κάνουμε και τι **δεν** κάνουμε ακόμα.
- Αν μια φάση έχει "open decision" που χρειάζεται εσένα, σταματάω και ρωτάω — δεν μαντεύω.
- Ποτέ destructive schema changes (`DROP TABLE`) σε production data — μόνο additive migrations.
- Ποτέ auth check μπροστά από το inbound email handler ή το `/api/ingest`.
- Καμία αυτόματη αντιστοίχιση ασαφών ονομάτων (π.χ. bare first name) σε συγκεκριμένο email — αυτό είναι δική σου απόφαση.

---

## 8. Πώς θα δουλεύουμε από εδώ και πέρα

Σε κάθε νέα συνεδρία μαζί μου:
1. Θα ξεκινάω επιβεβαιώνοντας την τρέχουσα κατάσταση (ό,τι είναι στο πιο πρόσφατο zip/κώδικα που μου δίνεις).
2. Θα δηλώνω ποια φάση/task δουλεύουμε και τι μένει εκτός scope.
3. Θα ενημερώνω αυτό το manual (ή θα σου λέω τι άλλαξε) ώστε να έχεις πάντα μια ενημερωμένη «πηγή αλήθειας» — ό,τι κάνουμε **από σήμερα, 6/9/2026, και μετά** θα καταγράφεται εδώ.

### Changelog
- **2026-09-17** — **Login με κωδικό 6 ψηφίων αντί για magic link.** Το Microsoft 365 της Καυκάς δεν παρέδιδε τα emails με link (το Resend τα δεχόταν). Το email πλέον περιέχει μόνο κωδικό (χωρίς link), που πληκτρολογείται στη σελίδα. Κωδικός: 6 ψηφία, 10 λεπτά, 3 προσπάθειες, αποθηκεύεται hashed, max 3 αποστολές/λεπτό. Ίδιοι κανόνες domain/`ALLOWED_EMAILS`. Τα endpoints magic link και τα υπόλοιπα email-otp flows (password reset κ.λπ.) είναι κλειστά. Αν αποτύχει η αποστολή στο Resend, ο χρήστης βλέπει σφάλμα (όχι ψευδή επιτυχία). Υπάρχοντα sessions δεν επηρεάζονται.
- **2026-09-17** — **Νέο URL: `https://kafkas-relay.pages.dev`** (το `relay.pages.dev` ήταν πιασμένο). Νέο Cloudflare Pages project `kafkas-relay` (φάκελος `pages/`) που προωθεί κάθε request στον ίδιο Worker `relay` μέσω service binding — email capture, cron, D1, AI μένουν ως έχουν. Το παλιό `relay.nkourouklis.workers.dev` ανακατευθύνει (302) στο νέο, εκτός από `/api/ingest`. Όλοι χρειάζεται να ξανακάνουν login μία φορά (τα cookies δένονται στο νέο domain).
- **2026-09-17** — **Φάση 1: περιορισμός login + ρόλοι + created_by σε λογαριασμό.** Login μόνο `@kafkas.gr` + `ALLOWED_EMAILS`. Νέα στήλη `relay_users.role` (`admin`/`user`). Νέες στήλες `projects.created_by_user_id`, `asks.created_by_user_id`. Server-side έλεγχος πρόσβασης σε όλα τα endpoints projects/asks/dashboard/capture (user: μόνο τα δικά του, admin: όλα). `POST /api/asks/:id/status` δέχεται πλέον μόνο `open`/`accepted`/`done`. `POST /api/asks` απαιτεί project που έχεις πρόσβαση (όχι default `demo`) και τίτλο. UI: Edit/Delete ask και «Διαγραφή project» εμφανίζονται μόνο σε δημιουργό ή admin· το login δείχνει το μήνυμα απόρριψης domain. Αποφάσεις: admin bootstrap με χειροκίνητο SQL· legacy δεδομένα χωρίς αντιστοίχιση → μόνο admin· «δικό μου» = δημιουργός. Δεν άλλαξαν: `/api/ingest`, email handler, extraction, script `db:remote`.
- **2026-09-06** — Ανάλυση του τρέχοντος `relay.zip`: επιβεβαιώθηκε ότι Phases A–C του auth plan έχουν υλοποιηθεί πλήρως στον κώδικα (users table, Better Auth + magic link, route protection, login UI). Δημιουργήθηκαν τα τρία έγγραφα αναφοράς (αρχιτεκτονική, user manual, product owner manual).
