import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// paths.ts reads WARD_T3_HOME on import, so point it at a scratch T3 home first.
const t3Home = mkdtempSync(join(tmpdir(), "ward-paths-"));
process.env.WARD_T3_HOME = t3Home;
const { DEFAULT_WORKTREES_DIR, locate, threadDesktopId, wardTrashDir } = await import("../src/paths.ts");
const settings = join(t3Home, "userdata/settings.json");
mkdirSync(join(t3Home, "userdata"));
test.after(() => rmSync(t3Home, { recursive: true }));

/** ward-lib.sh's ward_resolve on DIR: "<id> <root>", or "" for no ward. */
function shellResolve(dir: string): string {
  const lib = join(import.meta.dirname, "../libexec/ward-lib.sh");
  const script = `. "${lib}"; ward_resolve "$1" && printf '%s %s' "$WARD_ID" "$WARD_ROOT" || true`;
  return spawnSync("sh", ["-c", script, "sh", dir], { encoding: "utf8", env: { ...process.env, WARD_T3_HOME: t3Home } }).stdout;
}

test("locate sanitizes names byte by byte, like ward-lib.sh", () => {
  assert.equal(locate(join(DEFAULT_WORKTREES_DIR, "café", "t3-1", "src"))?.id, "caf__.t3-1");
  assert.equal(locate(join(DEFAULT_WORKTREES_DIR, "repo")), undefined);
  assert.equal(locate("/elsewhere/repo/x"), undefined);
});

test("worktrees in T3's worktreesDirectory have wards, and the default folder's keep theirs", () => {
  writeFileSync(settings, JSON.stringify({ worktreesDirectory: "/srv/wt/" }, null, 2));
  try {
    const cases: [dir: string, ward: string][] = [
      ["/srv/wt/repo/t3-1/src", "repo.t3-1 /srv/wt/repo/t3-1"],
      [join(DEFAULT_WORKTREES_DIR, "repo/t3-2"), `repo.t3-2 ${DEFAULT_WORKTREES_DIR}/repo/t3-2`],
      ["/srv/wt/repo", ""],
      ["/elsewhere/repo/x", ""],
    ];
    for (const [dir, ward] of cases) {
      const location = locate(dir);
      assert.equal(location ? `${location.id} ${location.root}` : "", ward, dir);
      assert.equal(shellResolve(dir), ward, `ward-lib.sh: ${dir}`);
    }
  } finally {
    rmSync(settings);
  }
});

test("wardTrashDir keys trash by worktree, so colliding ids don't share it", () => {
  assert.notEqual(wardTrashDir("r.c_1", "/w/r/c.1"), wardTrashDir("r.c_1", "/w/r/c_1"));
});

test("a thread desktop's id has no dot, so it is never a ward's id", () => {
  assert.equal(threadDesktopId("mcp:launch:ab.c"), "t-mcp_launch_ab_c");
  assert.ok(locate(join(DEFAULT_WORKTREES_DIR, "t-x", "y"))?.id.includes("."));
});
