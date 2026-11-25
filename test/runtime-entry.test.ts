import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// ward-init-root shows a ward only these entries of your runtime folder; every other
// socket there (other Claude sessions, gpg-agent, the keyring's own) must stay absent.
// A trailing / marks one that must be a folder.
test("ward_runtime_entry lists what a ward sees of your runtime folder", () => {
  const expected: Record<string, "ro" | "ro/" | "rw" | "rw/" | "absent"> = {
    "wayland-0": "ro",
    "wayland-1": "ro",
    "wayland-0.lock": "absent",
    "wayland-1x": "absent",
    "umbriel-wayland-0.sock": "ro",
    "umbriel-wayland-0x.sock": "absent",
    "pipewire-0": "ro",
    "pipewire-0-manager": "absent",
    pulse: "ro/",
    "pnpm-store-operation-locks-1000": "rw/",
    "pnpm-store-operation-locks-1000/": "absent",
    "pnpm-store-operation-locks": "absent",
    "pnpm-store-operation-locks-1001": "absent",
    "pnpm-other": "absent",
    caliban: "rw/",
    "caliban/ puck.lock": "absent",
    "puck.lock": "rw",
    "puck-follows-mouse": "absent",
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
  const lib = join(import.meta.dirname, "../libexec/ward-runtime.sh");
  const script = `. "${lib}"; for n in "$@"; do if ward_runtime_entry "$n" 1000; then echo "$n\t$_rwe"; else echo "$n\tabsent"; fi; done`;
  const out = spawnSync("bash", ["-c", script, "bash", ...Object.keys(expected)], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  });
  assert.equal(out.stderr, "");
  assert.equal(out.status, 0);
  const got = Object.fromEntries(out.stdout.trim().split("\n").map((line) => line.split("\t")));
  assert.deepEqual(got, expected);
});
