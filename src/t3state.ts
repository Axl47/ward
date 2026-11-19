// Read-only view of T3's thread state, used by the reconciler to decide when a
// ward should stop (its threads settled or archived) or go away (threads deleted).
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { T3_STATE_DB } from "./paths.ts";

export interface ThreadState {
  readonly threadId: string;
  readonly worktree: string;
  /** Deleted threads never come back. */
  readonly deleted: boolean;
  /** Settled or archived: no agent work is expected until someone reopens it. */
  readonly idle: boolean;
}

interface Row {
  readonly thread_id: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly worktree: string;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly unsettled_at: string | null;
}

/** Threads grouped by worktree path, or undefined when T3's database is missing. */
export function threadsByWorktree(dbPath = T3_STATE_DB): Map<string, ThreadState[]> | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `select thread_id, archived_at, deleted_at,
                json_extract(payload_json, '$.worktreePath') as worktree,
                json_extract(payload_json, '$.settledOverride') as settled_override,
                json_extract(payload_json, '$.settledAt') as settled_at,
                json_extract(payload_json, '$.unsettledAt') as unsettled_at
           from orchestration_v2_projection_threads
          where json_extract(payload_json, '$.worktreePath') is not null`,
      )
      .all() as unknown as Row[];
    const byWorktree = new Map<string, ThreadState[]>();
    for (const row of rows) {
      const state: ThreadState = {
        threadId: row.thread_id,
        worktree: row.worktree,
        deleted: row.deleted_at !== null,
        idle: row.archived_at !== null || isSettled(row),
      };
      byWorktree.set(row.worktree, [...(byWorktree.get(row.worktree) ?? []), state]);
    }
    return byWorktree;
  } finally {
    db.close();
  }
}

function isSettled(row: Row): boolean {
  if (row.settled_override === "settled") return true;
  if (row.settled_override === "active" || row.settled_at === null) return false;
  return row.unsettled_at === null || row.settled_at > row.unsettled_at;
}
