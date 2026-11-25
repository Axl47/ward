import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sync_runtime (libexec/ward-runtime.sh) as ward-init-root runs it (test/runtime-view.sh):
// the ward's copy of the view must show listed entries read-only, everything else
// absent, and entries that appear, change or go later the same way.
const userns = spawnSync("unshare", ["-Urm", "true"]).status === 0;


test("a ward's view shows listed entries read-only and follows yours", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-runtime-"));
  try {
    const out = spawnSync("unshare", ["-Urm", join(import.meta.dirname, "runtime-view.sh"), join(import.meta.dirname, "../libexec"), dir], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    });
    assert.equal(out.stderr, "");
    assert.deepEqual(out.stdout.trim().split("\n"), [
      "start pulse:ro wayland-0:ro ",
      "content old",
      // caliban is shared writable; wayland-3, a hard link, and keyring, off the list, stay out.
      "late caliban:rw pulse:ro wayland-0:ro wayland-2:ro ",
      "remount refused",
      "after caliban:rw pulse:ro wayland-0:ro ",
      "content new",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
