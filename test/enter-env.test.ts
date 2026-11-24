import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// bin/ward runs ward_enter_env before a command joins a ward: Annex's Claude hook
// lives in a folder the ward hides, so a Claude started inside must not inherit it.
test("ward_enter_env drops CLAUDE_CODE_SHELL_PREFIX and leaves the rest", () => {
  const lib = join(import.meta.dirname, "../libexec/ward-lib.sh");
  const out = spawnSync("sh", ["-c", `. "${lib}"; ward_enter_env; printf '%s|%s' "\${CLAUDE_CODE_SHELL_PREFIX-unset}" "$BASH_ENV"`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", CLAUDE_CODE_SHELL_PREFIX: "/x/prefix", BASH_ENV: "/x/bash-env" },
  });
  assert.equal(out.stdout, "unset|/x/bash-env");
});
