import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_WINDOW_MS,
  approvalExpiresAt,
  draftCapabilities,
  isApprovalActive,
} from "../src/approval-window.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();

test("approval window is 30 minutes", () => {
  assert.equal(APPROVAL_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(approvalExpiresAt(iso(0)), iso(APPROVAL_WINDOW_MS));
  assert.equal(approvalExpiresAt("not-a-date"), null);
});

test("approval is active up to and including the boundary, never after", () => {
  assert.equal(isApprovalActive(iso(-29 * 60 * 1000), NOW), true);
  assert.equal(isApprovalActive(iso(-APPROVAL_WINDOW_MS), NOW), true);
  assert.equal(isApprovalActive(iso(-APPROVAL_WINDOW_MS - 1), NOW), false);
  assert.equal(isApprovalActive("garbage", NOW), false);
});

test("unapproved live draft can be approved or rejected but not created", () => {
  const caps = draftCapabilities({ status: "pending", expiresAt: iso(10 * 60 * 1000), approval: null, now: NOW });
  assert.deepEqual(
    [caps.can_approve, caps.can_reject, caps.can_create, caps.approval_expired],
    [true, true, false, false]
  );
});

test("expired unapproved draft cannot be approved, rejected or created", () => {
  const caps = draftCapabilities({ status: "pending", expiresAt: iso(-1000), approval: null, now: NOW });
  assert.deepEqual([caps.can_approve, caps.can_reject, caps.can_create], [false, false, false]);
});

test("approved draft can be created but never rejected or re-approved", () => {
  const caps = draftCapabilities({
    status: "pending", expiresAt: iso(-60 * 1000), approval: { approved_at: iso(-60 * 1000) }, now: NOW,
  });
  assert.deepEqual(
    [caps.can_approve, caps.can_reject, caps.can_create, caps.approval_expired],
    [false, false, true, false]
  );
  assert.equal(caps.approval_expires_at, iso(-60 * 1000 + APPROVAL_WINDOW_MS));
});

test("approval past the window is expired, not creatable, not rejectable", () => {
  const caps = draftCapabilities({
    status: "pending", expiresAt: iso(-3600 * 1000), approval: { approved_at: iso(-APPROVAL_WINDOW_MS - 1000) }, now: NOW,
  });
  assert.deepEqual(
    [caps.can_approve, caps.can_reject, caps.can_create, caps.approval_expired],
    [false, false, false, true]
  );
});

test("a commit that already started may continue; a committed draft may not be created again", () => {
  const started = draftCapabilities({
    status: "committing", expiresAt: iso(-3600 * 1000), approval: { approved_at: iso(-APPROVAL_WINDOW_MS - 1000) }, now: NOW,
  });
  assert.equal(started.can_create, true);
  const done = draftCapabilities({
    status: "committed", expiresAt: iso(-3600 * 1000), approval: { approved_at: iso(-1000) }, now: NOW,
  });
  assert.deepEqual([done.can_create, done.can_reject, done.can_approve], [false, false, false]);
});
