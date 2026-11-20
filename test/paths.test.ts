import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { locate, threadDesktopId, wardTrashDir, WORKTREES_DIR } from "../src/paths.ts";

test("locate sanitizes names byte by byte, like ward-lib.sh", () => {
  assert.equal(locate(join(WORKTREES_DIR, "café", "t3-1", "src"))?.id, "caf__.t3-1");
  assert.equal(locate(join(WORKTREES_DIR, "repo")), undefined);
  assert.equal(locate("/elsewhere/repo/x"), undefined);
});

test("wardTrashDir keys trash by worktree, so colliding ids don't share it", () => {
  assert.notEqual(wardTrashDir("r.c_1", "/w/r/c.1"), wardTrashDir("r.c_1", "/w/r/c_1"));
});

test("a thread desktop's id has no dot, so it is never a ward's id", () => {
  assert.equal(threadDesktopId("mcp:launch:ab.c"), "t-mcp_launch_ab_c");
  assert.ok(locate(join(WORKTREES_DIR, "t-x", "y"))?.id.includes("."));
});
