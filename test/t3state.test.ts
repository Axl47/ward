import assert from "node:assert/strict";
import { test } from "node:test";
import { isSettled, threadState } from "../src/t3state.ts";

const t1 = "2026-11-19T10:00:00.000Z";
const t2 = "2026-11-19T11:00:00.000Z";

test("isSettled follows the override, then the latest of settle and unsettle", () => {
  assert.equal(isSettled({ settledAt: t1 }), true);
  assert.equal(isSettled({ settledAt: t1, unsettledAt: t2 }), false);
  assert.equal(isSettled({ settledAt: t2, unsettledAt: t1 }), true);
  assert.equal(isSettled({ settledOverride: "active", settledAt: t2 }), false);
  assert.equal(isSettled({ settledOverride: "settled", settledAt: t1, unsettledAt: t2 }), true);
  assert.equal(isSettled({}), false);
});

test("threadState takes the latest idle time and skips threads without a worktree", () => {
  assert.equal(threadState({ id: "a", worktreePath: null }), undefined);
  assert.deepEqual(threadState({ id: "a", worktreePath: "/w" }), { threadId: "a", worktree: "/w", idleSince: undefined });
  assert.equal(threadState({ id: "a", worktreePath: "/w", archivedAt: t1, settledAt: t2 })?.idleSince, t2);
  assert.equal(threadState({ id: "a", worktreePath: "/w", deletedAt: t2, settledAt: t1, unsettledAt: t2 })?.idleSince, t2);
  assert.equal(threadState({ id: "a", worktreePath: "/w", settledAt: t1, unsettledAt: t2 })?.idleSince, undefined);
});
