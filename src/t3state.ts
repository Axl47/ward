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

/** Threads grouped by worktree path. Throws when T3 is unreachable or the token is missing or rejected. */
export async function threadsByWorktree(): Promise<Map<string, ThreadState[]>> {
  const token = readFileSync(T3_TOKEN_FILE, "utf8").trim();
  const res = await fetch(`${t3Origin()}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2", accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`T3 answered HTTP ${res.status}${res.status === 401 ? " (token expired or revoked; rerun `ward install`)" : ""}`);
  const { threads } = (await res.json()) as { threads: readonly ShellThread[] };
  const byWorktree = new Map<string, ThreadState[]>();
  for (const thread of threads) {
    const state = threadState(thread);
    if (state !== undefined) byWorktree.set(state.worktree, [...(byWorktree.get(state.worktree) ?? []), state]);
  }
  return byWorktree;
}

/** A thread's worktree and idle time, or undefined when it has no worktree. */
export function threadState(thread: ShellThread): ThreadState | undefined {
  if (!thread.worktreePath) return undefined;
  const idleSince = [thread.deletedAt, thread.archivedAt, isSettled(thread) ? thread.settledAt : undefined]
    .filter((t): t is string => Boolean(t))
    .sort()
    .at(-1);
  return { threadId: thread.id, worktree: thread.worktreePath, idleSince };
}

export function isSettled(thread: Pick<ShellThread, "settledOverride" | "settledAt" | "unsettledAt">): boolean {
  if (thread.settledOverride === "settled") return Boolean(thread.settledAt);
  if (thread.settledOverride === "active" || !thread.settledAt) return false;
  return !thread.unsettledAt || thread.settledAt > thread.unsettledAt;
}
