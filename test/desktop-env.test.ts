import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A desktop's env file is written inside the ward, and bin/ward loads it on the
// host before joining the ward (`ward desktop -- CMD`), so it must be read as data.
// ward_desktop_read checks the lines (test/desktop.test.ts); ward_desktop_env
// exports what it kept.
test("ward_desktop_env takes the checked lines verbatim and runs nothing from them", () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-denv-"));
  try {
    const marker = join(dir, "ran");
    mkdirSync(join(dir, "desktop"));
    writeFileSync(
      join(dir, "desktop/env"),
      [`WAYLAND_DISPLAY=$(touch ${marker})`, "XDG_RUNTIME_DIR=/run/user/1000/ward/d9000000001", "DISPLAY="].join("\n") + "\n",
    );
    const lib = join(import.meta.dirname, "../libexec/ward-lib.sh");
    const out = spawnSync("sh", ["-c", `. "${lib}"; _denv=$(cat "$1/desktop/env"); ward_desktop_env; printf '%s|%s|%s|%s' "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" "$PATH" "\${DISPLAY-unset}"`, "sh", dir], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: dir },
    });
    assert.equal(out.stdout, `$(touch ${marker})|/run/user/1000/ward/d9000000001|/usr/bin:/bin|`);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
