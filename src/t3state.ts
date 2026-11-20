// T3's thread state, read from the server's orchestration API with a read-only
// token. The reconciler uses it to stop a ward once no thread needs it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, T3_HOME } from "./paths.ts";

/** Issued by `ward install`: `t3 auth session issue --scope orchestration:read`. */
export const T3_TOKEN_FILE = join(CONFIG_DIR, "t3-token");

export interface ThreadState {
  readonly threadId: string;
  readonly worktree: string;
  /**
   * When the thread was settled, archived or deleted (no agent work is expected
   * until someone reopens it), or undefined while it is active.
   */
  readonly idleSince: string | undefined;
}

export interface ShellThread {
  readonly id: string;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly settledOverride?: string | null;
  readonly settledAt?: string | null;
  readonly unsettledAt?: string | null;
}

function t3Origin(): string {
  try {
    const runtime = JSON.parse(readFileSync(join(T3_HOME, "userdata/server-runtime.json"), "utf8")) as { origin?: string };
    if (runtime.origin) return runtime.origin;
  } catch {}
  return "http://127.0.0.1:3773";
}

/** Every thread T3 knows. Throws when T3 is unreachable or the token is missing or rejected. */
export async function loadThreads(): Promise<readonly ShellThread[]> {
  const token = readFileSync(T3_TOKEN_FILE, "utf8").trim();
  const res = await fetch(`${t3Origin()}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2", accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`T3 answered HTTP ${res.status}${res.status === 401 ? " (token expired or revoked; rerun `ward install`)" : ""}`);
  return ((await res.json()) as { threads: readonly ShellThread[] }).threads;
}

/** Threads grouped by worktree path; threads without a worktree are left out. */
export function threadsByWorktree(threads: readonly ShellThread[]): Map<string, ThreadState[]> {
  const byWorktree = new Map<string, ThreadState[]>();
  for (const thread of threads) {
    const state = threadState(thread);
    if (state !== undefined) byWorktree.set(state.worktree, [...(byWorktree.get(state.worktree) ?? []), state]);
  }
  return byWorktree;
}

/** When the thread was settled, archived or deleted, or undefined while it is active. */
export const idleSince = (thread: ShellThread): string | undefined =>
  [thread.deletedAt, thread.archivedAt, isSettled(thread) ? thread.settledAt : undefined]
    .filter((t): t is string => Boolean(t))
    .sort()
    .at(-1);

/** A thread's worktree and idle time, or undefined when it has no worktree. */
export function threadState(thread: ShellThread): ThreadState | undefined {
  if (!thread.worktreePath) return undefined;
  return { threadId: thread.id, worktree: thread.worktreePath, idleSince: idleSince(thread) };
}

/** How long a ward whose worktree has no active thread (archived, deleted, or none) may sit unused. */
export const NO_THREAD_GRACE_MS = 30 * 60_000;

/** How long a thread's desktop may run with nothing asking for it, even while its thread is active. */
export const DESKTOP_IDLE_MS = 2 * 60 * 60_000;

/**
 * Whether the reconciler should stop a running ward, or a thread's desktop
 * (its threads: that one, if T3 knows it). lastActivity is when it
 * last started, ran a command, or got terminal input (ms). With threads, once all are idle:
 * right away if the latest went idle after that activity, else (someone used a
 * settled thread's worktree) after NO_THREAD_GRACE_MS unused. Without threads:
 * after NO_THREAD_GRACE_MS unused.
 */
export function shouldStop(threads: readonly Pick<ThreadState, "idleSince">[], lastActivity: number, now: number): boolean {
  const unused = now - lastActivity > NO_THREAD_GRACE_MS;
  if (threads.length === 0) return unused;
  const idle = threads.map((t) => (t.idleSince === undefined ? Number.NaN : Date.parse(t.idleSince)));
  return !idle.some(Number.isNaN) && (Math.max(...idle) > lastActivity || unused);
}

/**
 * What the reconciler does with a thread's desktop (`thread`: the thread in T3's
 * list, if it is there; `used`: the desktop's last use, ms). It stops a running
 * desktop once shouldStop says so, with the thread as its one thread (none when
 * T3 doesn't list it), or after DESKTOP_IDLE_MS unused; and once T3 doesn't list
 * the thread and NO_THREAD_GRACE_MS passed, drops the last log, never in the pass
 * that stopped or cleared it (`died`): a call that raced that pass has one to come
 * back. Nothing here forgets the thread: a thread missing from T3's list may be
 * served by another T3 or listed again later, and forgetting it would send its
 * next Puck call to the user's screen.
 */
export function threadDesktopStep(
  thread: ShellThread | undefined,
  running: boolean,
  died: boolean,
  used: number,
  now: number,
): "the thread is done" | "unused, and T3 has no such thread" | `unused for ${number} h` | "drop log" | undefined {
  const done = shouldStop(thread ? [{ idleSince: idleSince(thread) }] : [], used, now);
  if (running && done) return thread ? "the thread is done" : "unused, and T3 has no such thread";
  if (running && now - used > DESKTOP_IDLE_MS) return `unused for ${DESKTOP_IDLE_MS / 3_600_000} h`;
  if (!running && !died && !thread && now - used > NO_THREAD_GRACE_MS) return "drop log";
  return undefined;
}

export function isSettled(thread: Pick<ShellThread, "settledOverride" | "settledAt" | "unsettledAt">): boolean {
  if (thread.settledOverride === "settled") return Boolean(thread.settledAt);
  if (thread.settledOverride === "active" || !thread.settledAt) return false;
  return !thread.unsettledAt || thread.settledAt > thread.unsettledAt;
}
