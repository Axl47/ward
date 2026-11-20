import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// ward_desktop_read takes nothing in the shared runtime folder on trust. The
// desktop's process here is the test's own shell, so its unit is the last part
// of this process's cgroup (the shell inherits it).
const unit = readFileSync("/proc/self/cgroup", "utf8").trim().split("/").at(-1) ?? "";
const root = mkdtempSync(join(tmpdir(), "ward-desktop-"));
const runtime = join(root, "ward");
const desktop = join(runtime, "t-x", "desktop");
const live = join(root, "live");
mkdirSync(desktop, { recursive: true });
mkdirSync(live);
const servers: Server[] = [];
const listen = (path: string) =>
  new Promise<void>((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen(path, resolve);
  });
await Promise.all([...["wayland-0", "umbriel-wayland-0.sock", "bus"].map((s) => listen(join(desktop, s))), listen(join(live, "wayland-0"))]);
test.after(() => {
  servers.forEach((s) => s.close());
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs ward_desktop_read for desktop t-x, with `env` as given ($D: the desktop's
 * short name). Its pid is the shell's own (`$$`) unless given, as the holder's
 * PID namespace sees it.
 */
function read(env: string, expectUnit = unit, { pid = "$$", holder = "" } = {}): { ok: boolean; out: string } {
  const lib = join(import.meta.dirname, "../libexec/ward-lib.sh");
  const script = `. "${lib}"
    WARD_RUNTIME="$1"; D=$WARD_RUNTIME/d$$
    echo "${pid}" > "$WARD_RUNTIME/t-x/desktop/pid"; ln -sfn t-x/desktop "$D"
    printf '%s\\n' "$2" | sed "s|\\$D|$D|g" > "$WARD_RUNTIME/t-x/desktop/env"
    ward_desktop_read t-x "$3" "$4" && printf '%s' "$_denv"; rc=$?; rm -f "$D"; exit $rc`;
  const r = spawnSync("sh", ["-c", script, "sh", runtime, env, expectUnit, holder], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout };
}

const good = "XDG_RUNTIME_DIR=$D\nWAYLAND_DISPLAY=wayland-0\nUMBRIEL_SOCKET=$D/umbriel-wayland-0.sock\nDBUS_SESSION_BUS_ADDRESS=unix:path=$D/bus\nTMPDIR=$D/tmp\nDISPLAY=";

test("a desktop whose process, environment and sockets are its own is used", { skip: !unit.includes(".") && "no unit in this process's cgroup" }, () => {
  const { ok, out } = read(good);
  assert.ok(ok);
  assert.match(out, /^XDG_RUNTIME_DIR=.*\/d\d+$/m);
});

test("a desktop is refused when its process isn't in the desktop's unit", () => {
  assert.equal(read(good, "ward-desktop-t-x.service").ok, false);
});

test("a desktop is refused when its environment points anywhere but its own folder", { skip: !unit.includes(".") && "no unit in this process's cgroup" }, () => {
  assert.equal(read(good.replace("XDG_RUNTIME_DIR=$D", `XDG_RUNTIME_DIR=${live}`)).ok, false);
  assert.equal(read(good.replace("unix:path=$D/bus", `unix:path=${live}/bus`)).ok, false);
  assert.equal(read(good.replace("WAYLAND_DISPLAY=wayland-0", "WAYLAND_DISPLAY=../../live/wayland-0")).ok, false);
  assert.equal(read(`${good}\nLD_PRELOAD=/tmp/x.so`).ok, false);
});

test("a desktop is refused when a socket in its folder is a link to another server's", { skip: !unit.includes(".") && "no unit in this process's cgroup" }, async () => {
  const socket = join(desktop, "wayland-0");
  unlinkSync(socket);
  try {
    symlinkSync(join(live, "wayland-0"), socket);
    assert.equal(read(good).ok, false);
    unlinkSync(socket);
    linkSync(join(live, "wayland-0"), socket); // a hard link connects to the live server just the same
    assert.equal(read(good).ok, false);
  } finally {
    rmSync(socket, { force: true });
    await listen(socket); // the desktop's own again, for the tests after this one
  }
});

test("a ward's desktop pid is the ward's own, looked up through its namespace holder", { skip: !unit.includes(".") && "no unit in this process's cgroup" }, async () => {
  // A stand-in ward: a PID namespace whose init (pid 1 inside) is the holder, in this process's cgroup.
  const ns = spawn("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--kill-child", "sleep", "30"], { stdio: "ignore" });
  try {
    // Its child, once it runs sleep: by then its /proc is the namespace's.
    let holder = "";
    for (let i = 0; i < 100 && !holder; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const child = readFileSync(`/proc/${ns.pid}/task/${ns.pid}/children`, "utf8").trim();
      if (child && readFileSync(`/proc/${child}/comm`, "utf8").trim() === "sleep") holder = child;
    }
    assert.ok(holder, "the stand-in ward didn't start");
    assert.equal(read(good, unit, { pid: "1", holder }).ok, true);
    // A host pid means nothing in the ward's namespace, and a holder in this PID namespace is no ward's.
    assert.equal(read(good, unit, { pid: String(process.pid), holder }).ok, false);
    assert.equal(read(good, unit, { pid: "1", holder: String(process.pid) }).ok, false);
    assert.equal(read(good, "ward@x.service", { pid: "1", holder }).ok, false);
  } finally {
    ns.kill("SIGKILL"); // --kill-child takes the namespace with it; its init ignores SIGTERM
  }
});
