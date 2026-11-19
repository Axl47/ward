import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { locate, WORKTREES_DIR } from "../src/paths.ts";

test("locate sanitizes names byte by byte, like ward-lib.sh", () => {
  assert.equal(locate(join(WORKTREES_DIR, "café", "t3-1", "src"))?.id, "caf__.t3-1");
  assert.equal(locate(join(WORKTREES_DIR, "repo")), undefined);
  assert.equal(locate("/elsewhere/repo/x"), undefined);
});
