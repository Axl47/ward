import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// ward-init-root shows a ward only these entries of your runtime folder; every other
// socket there (other Claude sessions, gpg-agent, the keyring's own) must stay absent.
test("ward_runtime_entry lists what a ward sees of your runtime folder", () => {
  const expected: Record<string, "ro" | "rw" | "absent"> = {
    "wayland-0": "ro",
    "wayland-1": "ro",
    "wayland-0.lock": "absent",
    "umbriel-wayland-0.sock": "ro",
    "pipewire-0": "ro",
    "pipewire-0-manager": "absent",
    pulse: "ro",
    "pnpm-store-operation-locks-1000": "rw",
    "puck.lock": "rw",
    "cc-socks": "absent",
    gnupg: "absent",
    keyring: "absent",
    "p11-kit": "absent",
    containers: "absent",
    ariel: "absent",
    "noctalia-wayland-0.sock": "absent",
    quickshell: "absent",
    systemd: "absent",
    podman: "absent",
    libpod: "absent",
    bus: "absent",
    ward: "absent",
  };
  const lib = join(import.meta.dirname, "../libexec/ward-lib.sh");
  const script = `. "${lib}"; for n in "$@"; do if ward_runtime_entry "$n"; then echo "$n $_rwe"; else echo "$n absent"; fi; done`;
  const out = spawnSync("sh", ["-c", script, "sh", ...Object.keys(expected)], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  });
  const got = Object.fromEntries(out.stdout.trim().split("\n").map((line) => line.split(" ")));
  assert.deepEqual(got, expected);
});
