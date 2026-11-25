import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// runtime_view and sync_runtime (libexec/ward-runtime.sh) as ward-init-root runs them
// (test/runtime-view.sh): the ward's copy of the view must show listed entries
// read-only, everything else absent, and entries that appear, change or go later the
// same way.
const userns = spawnSync("unshare", ["-Urm", "true"]).status === 0;

test("a ward's view shows listed entries read-only and follows yours", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  const out = spawnSync("unshare", ["-Urm", join(import.meta.dirname, "runtime-view.sh"), join(import.meta.dirname, "../libexec")], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  });
  assert.equal(out.stderr, "");
  assert.equal(out.status, 0);
  assert.deepEqual(out.stdout.trim().split("\n"), [
    "link refused",
    // XDG_RUNTIME_DIR's folder (w), under /run/user/<uid>, is there, and only that.
    "start bus:ro pulse:ro w: wayland-0:ro ",
    "inner bus:ro ward:rw ",
    "t",
    "content old",
    // caliban is shared writable; wayland-3 (a hard link), puck.lock (a folder) and keyring stay out.
    "late bus:ro caliban:rw pulse:ro w: wayland-0:ro wayland-2:ro wayland-5:ro ",
    "remount refused",
    "view kept",
    // wayland-5 is the ward's own link now.
    "after bus:ro caliban:rw pulse:ro w: wayland-0:ro wayland-3:ro wayland-5: ",
    "content new",
  ]);
});
