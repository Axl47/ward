import assert from "node:assert/strict";
import { test } from "node:test";
import { isSettled, NO_THREAD_GRACE_MS, shouldStop, threadState } from "../src/t3state.ts";

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

test("shouldStop waits for every thread, and for idleness newer than the ward's last use", () => {
  const at = (iso: string) => Date.parse(iso);
  const thread = (idleSince: string | undefined) => ({ threadId: "t", worktree: "/w", idleSince });
  // One thread settled before the ward started, the other after: stop.
  assert.equal(shouldStop([thread(t1), thread(t2)], at("2026-11-19T10:30:00.000Z"), at(t2)), true);
  // A thread is still active: keep.
  assert.equal(shouldStop([thread(t2), thread(undefined)], 0, at(t2)), false);
  // Used (terminal opened) after the last thread settled: keep.
  assert.equal(shouldStop([thread(t1)], at(t2), at(t2)), false);
  // No active thread: stop only after the grace period without use.
  assert.equal(shouldStop([], at(t1), at(t1) + NO_THREAD_GRACE_MS - 1), false);
  assert.equal(shouldStop([], at(t1), at(t1) + NO_THREAD_GRACE_MS + 1), true);
});
