// Παράθυρο έγκρισης και επιτρεπτές ενέργειες ενός Copilot capture draft.
// Καθαρές συναρτήσεις, χωρίς DB: χρησιμοποιούνται από το Worker και από τα tests.

// Μετά την έγκριση, η δημιουργία ενεργειών επιτρέπεται μόνο για αυτό το διάστημα.
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000;

export function approvalExpiresAt(approvedAtIso) {
  const approvedMs = Date.parse(approvedAtIso);
  if (!Number.isFinite(approvedMs)) return null;
  return new Date(approvedMs + APPROVAL_WINDOW_MS).toISOString();
}

export function isApprovalActive(approvedAtIso, now = new Date()) {
  const approvedMs = Date.parse(approvedAtIso);
  if (!Number.isFinite(approvedMs)) return false;
  return now.getTime() <= approvedMs + APPROVAL_WINDOW_MS;
}

// status: pending | committing | committed (relay_mcp_capture_drafts.status)
// approval: { approved_at } ή null
export function draftCapabilities({ status, expiresAt, approval, now = new Date() }) {
  const nowIso = now.toISOString();
  const approved = !!approval;
  const editable = status === "pending" && !approved && String(expiresAt) > nowIso;
  // 'committing' = η δημιουργία ξεκίνησε μέσα στο παράθυρο και επιτρέπεται η συνέχισή της.
  const approvalLive = approved && (status === "committing" ||
    (status === "pending" && isApprovalActive(approval.approved_at, now)));
  return {
    can_approve: editable,
    can_reject: editable,
    can_create: approvalLive,
    approval_expires_at: approved ? approvalExpiresAt(approval.approved_at) : null,
    approval_expired: approved && status === "pending" && !approvalLive,
  };
}
