import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

// wardd as it runs, in scratch folders, with two registered "wards" that are bare
// network namespaces (unshare -Urn) rather than units: enough for wardd to tell who
// is calling, which is all this tests. /tmp, not TMPDIR: the socket path must fit 108 bytes.
const root = mkdtempSync("/tmp/wardc-");
const env = {
  ...process.env,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: join(root, "run"),
  WARD_T3_HOME: join(root, "t3"),
  WARD_UNIT: "wardcallertest",
};
const socket = join(root, "run/ward/wardd.sock");
const children: ChildProcess[] = [];
const userns = spawnSync("unshare", ["-Urn", "true"]).status === 0;

/** A process in a network namespace of its own; wardd sees a ward wherever a ward's pid file names one. */
function namespace(): ChildProcess {
  const holder = spawn("unshare", ["-Urn", "sleep", "60"], { stdio: "ignore" });
  children.push(holder);
  return holder;
}

/** Send one request to wardd from inside `holder`'s namespaces (or the host's): [status, body]. */
function call(holder: ChildProcess | undefined, route: string, body: unknown = {}, via = socket): [number, string] {
  const [method, path] = route.split(" ");
  const client = `const r=require("node:http").request({socketPath:${JSON.stringify(via)},method:${JSON.stringify(method)},path:${JSON.stringify(path)}},(res)=>{let d="";res.on("data",(c)=>d+=c);res.on("end",()=>console.log(res.statusCode+" "+d))});r.end(${method === "GET" ? "" : JSON.stringify(JSON.stringify(body))})`;
  const argv = holder === undefined ? [process.execPath, "-e", client] : ["nsenter", "-U", "-n", "-t", String(holder.pid), "--preserve-credentials", "--", process.execPath, "-e", client];
  const out = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" }).stdout.trim();
  const space = out.indexOf(" ");
  return [Number(out.slice(0, space)), out.slice(space + 1)];
}

let a: ChildProcess, stranger: ChildProcess;

before(async () => {
  if (!userns) return;
  const worktrees = join(root, "t3/worktrees/proj");
  for (const w of ["a", "b"]) mkdirSync(join(worktrees, w), { recursive: true });
  mkdirSync(join(root, "config/ward/enabled"), { recursive: true });
  writeFileSync(join(root, "config/ward/enabled/proj"), "");
  mkdirSync(join(root, "t3/userdata"), { recursive: true });
  writeFileSync(join(root, "t3/userdata/server-runtime.json"), JSON.stringify({ origin: "http://127.0.0.1:1" }));
  const record = (w: string, slot: number) => ({ id: `proj.${w}`, repo: "proj", worktree: join(worktrees, w), slot, ports: {}, createdAt: new Date().toISOString() });
  mkdirSync(join(root, "state/ward"), { recursive: true });
  writeFileSync(join(root, "state/ward/registry.json"), JSON.stringify({ version: 1, wards: { "proj.a": record("a", 1), "proj.b": record("b", 2) } }));
  const daemon = spawn(process.execPath, [new URL("../src/daemon.ts", import.meta.url).pathname], { env, stdio: "ignore" });
  children.push(daemon);
  for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
  // Only now, so wardd doesn't try to attach port mapping to them at start.
  a = namespace();
  stranger = namespace();
  for (const [w, holder] of [["a", a], ["b", namespace()]] as const) {
    mkdirSync(join(root, `run/ward/proj.${w}`), { recursive: true });
    writeFileSync(join(root, `run/ward/proj.${w}/pid`), String(holder.pid));
    writeFileSync(join(root, `run/ward/proj.${w}/ready`), "");
  }
});

after(() => {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
});

test("the host may call anything and sees every ward", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  const [status, body] = call(undefined, "GET /ls");
  assert.equal(status, 200);
  assert.deepEqual((JSON.parse(body) as { id: string }[]).map((w) => w.id), ["proj.a", "proj.b"]);
});

test("a ward sees only itself and can't act on another ward", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  const [status, body] = call(a, "GET /ls");
  assert.equal(status, 200);
  assert.deepEqual((JSON.parse(body) as { id: string }[]).map((w) => w.id), ["proj.a"]);
  assert.equal(call(a, "POST /stop", { id: "proj.b" })[0], 403);
  assert.equal(call(a, "POST /stop", { id: "proj.a" })[0], 403);
  assert.equal(call(a, "POST /rm", { id: "proj.b", now: true })[0], 403);
  assert.equal(call(a, "POST /port", { id: "proj.b", port: 80 })[0], 403);
  assert.equal(call(a, "POST /desktop", { thread: "x", cwd: "/" })[0], 403);
  assert.equal(call(a, "POST /up", { worktree: join(root, "t3/worktrees/proj/b") })[0], 403);
});

test("a caller in no ward's namespace is refused", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  assert.equal(call(stranger, "GET /ls")[0], 403);
});

test("wards reach wardd through the link it keeps in control/", { skip: !userns && "needs unprivileged user namespaces" }, () => {
  // A ward sees only control/ of the runtime folder's top (libexec/ward-init-root).
  const link = join(root, "run/ward/control/wardd.sock");
  assert.equal(statSync(link).ino, statSync(socket).ino);
  assert.equal(call(a, "GET /ls", {}, link)[0], 200);
});
