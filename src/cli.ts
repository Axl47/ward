// The `ward` CLI, except `ward exec` and what `ward desktop` does once the
// desktop is up (bin/ward handles those in shell).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { call, WardError, type DeviceList, type WardInfo } from "./api.ts";
import { parseDuration } from "./device.ts";
import { parseProjectHostPorts, wardHostPorts } from "./hostports.ts";
import { CONTROL_SOCKET, enabledMarker, locate, parsePorts, projectHostPorts, WARD_HOME, wardRuntimeDir } from "./paths.ts";
import { T3_TOKEN_FILE } from "./t3state.ts";

/** How long `ward device` waits for wardd: the first device of all waits for its ward to start and for a base image to be built. */
const DEVICE_TIMEOUT_MS = 600_000;

const USAGE = `usage: ward <command>

  exec [--worktree DIR] -- CMD...   run CMD in the worktree's ward
  desktop [--worktree DIR] [-- CMD...]
                                    run CMD on a private desktop, the ward's or, with no ward, the T3 thread's own;
                                    without CMD, print its environment
  device [--worktree DIR] [--keep DURATION] [--json]
                                    start the ward's own Android emulator unless it is up, and print its serial;
                                    it stops once unused for 15 minutes (WARD_DEVICE_IDLE); --keep counts it as in
                                    use for DURATION from now (90s, 30m, 2h; at most 4h)
  device stop [ID|--worktree DIR]   stop it; the next use starts a fresh one, without what was installed
  devices [--json]                  every ward's device
  up [--worktree DIR]               start the worktree's ward
  stop [ID|--worktree DIR]          stop a ward, keeping its data
  rm [ID|--worktree DIR] [--now]    remove a ward; its data stays in the trash for 7 days (--now: delete it)
  ls [--json]                       list wards
  ports [--json]                    this ward's port mappings (ward port → host port)
  port PORT                         host port for a ward port, mapping it if needed
  env                               this ward's environment
  enable [REPO] [--host-ports LIST] turn wards on for a project; LIST replaces the host ports its wards reach
  disable [REPO]                    turn wards off for a project
  gc                                run the reconciler now
  images ARGS...                    podman on the shared image store, e.g. images pull postgres:17
  install                           install the systemd units and put ward on PATH`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    worktree: { type: "string" },
    thread: { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    now: { type: "boolean" },
    "host-ports": { type: "string" },
    keep: { type: "string" },
  },
});
const [command, ...args] = positionals;
const flag = (name: "worktree" | "thread") => (typeof values[name] === "string" ? (values[name] as string) : undefined);

/**
 * The ward this command is about: explicit id, --worktree, $WARD_ID, or the
 * current folder. worktree is set when it was found by path.
 */
function target(explicit?: string): { id: string; worktree?: string } {
  const found = find(explicit);
  if (found === undefined) throw new WardError("not inside a T3 worktree; pass a ward id or --worktree");
  return found;
}
/** As target, but undefined for a folder that is no T3 worktree's. */
function find(explicit?: string): { id: string; worktree?: string } | undefined {
  if (explicit) return { id: explicit };
  const worktree = flag("worktree");
  if (worktree === undefined && process.env.WARD_ID) return { id: process.env.WARD_ID };
  const location = locate(worktree ?? process.cwd());
  return location && { id: location.id, worktree: location.root };
}
const currentId = () => target().id;

/** Start wardd if its socket is missing or stale (left behind by a crash). */
async function ensureDaemon(): Promise<void> {
  if (existsSync(CONTROL_SOCKET) && (await reachable())) return;
  // A second instance (WARD_UNIT set) must never start the installed wardd.service.
  if (process.env.WARD_UNIT !== undefined) throw new WardError(`wardd is not running at ${CONTROL_SOCKET}; start this instance's daemon (see AGENTS.md)`);
  spawnSync("systemctl", ["--user", "reset-failed", "wardd.service"], { stdio: "ignore" });
  // start, not restart: a concurrent caller may already have started it and be mid-request.
  spawnSync("systemctl", ["--user", "start", "wardd.service"], { stdio: "inherit" });
  for (let i = 0; i < 100; i++) {
    if (existsSync(CONTROL_SOCKET) && (await reachable())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new WardError("wardd is not running; see `journalctl --user -u wardd`");
}

const reachable = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect(CONTROL_SOCKET);
    socket.once("connect", () => (socket.end(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

function printPorts(ward: WardInfo): void {
  if (ward.ports.length === 0) return console.log("no ports yet");
  for (const p of ward.ports) console.log(`${p.ward}\t→ 127.0.0.1:${p.host}${p.listening ? "" : "\t(not listening)"}`);
}

function install(): void {
  const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user");
  const binDir = join(homedir(), ".local/bin");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  for (const unit of ["ward@.service", "wardd.service"]) {
    const text = readFileSync(join(WARD_HOME, "units", unit), "utf8")
      .replaceAll("@WARD_HOME@", WARD_HOME)
      .replaceAll("@NODE@", process.execPath);
    writeFileSync(join(unitDir, unit), text);
  }
  for (const bin of ["ward", "ward-prefix", "ward-bash-env"]) {
    rmSync(join(binDir, bin), { force: true });
    symlinkSync(join(WARD_HOME, "bin", bin), join(binDir, bin));
  }
  if (!existsSync(T3_TOKEN_FILE)) {
    // Read-only token for the reconciler's view of T3 thread state.
    const token = spawnSync("t3", ["auth", "session", "issue", "--scope", "orchestration:read", "--ttl", "365d", "--label", "ward", "--token-only"], { encoding: "utf8" });
    if (token.status === 0 && token.stdout.trim()) {
      mkdirSync(join(T3_TOKEN_FILE, ".."), { recursive: true });
      writeFileSync(T3_TOKEN_FILE, token.stdout.trim() + "\n", { mode: 0o600 });
    } else console.warn("ward: could not issue a T3 token; wards will not stop when threads settle");
  }
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", "wardd.service"]);
  execFileSync("systemctl", ["--user", "restart", "wardd.service"]);
  console.log(`installed units in ${unitDir} and ward, ward-prefix, ward-bash-env in ${binDir}`);
}

/** Name the project's running wards whose pasta still forwards another host port list, and how to apply the new one. */
async function reportStaleWards(repo: string, forwarded: string): Promise<void> {
  if (!existsSync(CONTROL_SOCKET) || !(await reachable())) return;
  const stale = (await call("GET /ls", {})).filter((w) => {
    if (w.repo !== repo || !w.running) return false;
    try {
      return parsePorts(readFileSync(join(wardRuntimeDir(w.id), "host-ports"), "utf8")).sort().join() !== forwarded.split(",").sort().join();
    } catch {
      return true;
    }
  });
  if (stale.length === 0) return;
  console.log(`running wards keep their old host ports until they restart; to apply now (stops their processes and containers):`);
  for (const w of stale) console.log(`  ward stop ${w.id}`);
}

function repoArg(): string {
  const explicit = args[0];
  if (explicit) return explicit;
  const location = locate(process.cwd());
  if (location) return location.repo;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0) return basename(top.stdout.trim());
  throw new WardError("pass a project name (its folder name under T3's worktrees folder)");
}

async function main(): Promise<void> {
  switch (command) {
    case "up": {
      await ensureDaemon();
      const result = await call("POST /up", { worktree: flag("worktree") ?? process.cwd() });
      if (!result.enabled) {
        if (!values.quiet) console.log(result.reason);
        process.exitCode = 3; // bin/ward runs the command unwarded on 3
        return;
      }
      if (!values.quiet) console.log(`${result.ward.id} is up (slot ${result.ward.slot})`);
      return;
    }
    case "stop":
    case "rm": {
      await ensureDaemon();
      const ward = target(args[0]);
      const id = ward.id;
      const now = values.now === true;
      const result = command === "stop" ? await call("POST /stop", ward) : await call("POST /rm", { ...ward, now });
      console.log(`${id}: ${"stopped" in result ? (result.stopped ? "stopped" : "was not running") : now ? "removed" : "removed (data in the trash for 7 days)"}`);
      return;
    }
    case "ls": {
      // No auto-start: T3 polls this, and a stopped wardd just means no running wards.
      if (!existsSync(CONTROL_SOCKET)) return console.log(values.json ? "[]" : "no wards");
      const list = await call("GET /ls", {});
      if (values.json) return console.log(JSON.stringify(list, null, 2));
      if (list.length === 0) return console.log("no wards");
      for (const w of list) {
        const ports = w.ports.map((p) => `${p.ward}→${p.host}`).join(" ");
        console.log(`${w.running ? "●" : "○"} ${w.id}\tslot ${w.slot}\t${ports}`);
      }
      return;
    }
    case "ports": {
      await ensureDaemon();
      const id = currentId();
      const ward = (await call("GET /ls", {})).find((w) => w.id === id);
      if (ward === undefined) throw new WardError(`no ward ${id}`);
      return values.json ? console.log(JSON.stringify(ward.ports, null, 2)) : printPorts(ward);
    }
    case "port": {
      const port = Number(args[0]);
      if (!Number.isInteger(port)) throw new WardError("usage: ward port PORT");
      await ensureDaemon();
      console.log((await call("POST /port", { id: currentId(), port })).host);
      return;
    }
    case "desktop":
      // From bin/ward, when the desktop isn't up; it prints the environment itself.
      await ensureDaemon();
      // 4: the thread belongs to a warded worktree, and bin/ward starts over with the note wardd left.
      if ((await call("POST /desktop", flag("thread") === undefined ? target() : { thread: flag("thread")!, cwd: process.cwd() })).ward !== undefined) process.exitCode = 4;
      return;
    case "device": {
      if (args[0] === "stop") {
        await ensureDaemon();
        const ward = target(args[1]);
        const { stopped } = await call("POST /device/stop", ward, DEVICE_TIMEOUT_MS); // it waits for a start under way
        return console.log(`${ward.id}: ${stopped ? "device stopped" : "had no device running"}`);
      }
      const keep = values.keep;
      const keepMs = keep === undefined ? undefined : typeof keep === "string" ? parseDuration(keep) : undefined;
      if (args.length > 0 || (keep !== undefined && keepMs === undefined)) throw new WardError("usage: ward device [--worktree DIR] [--keep 90s|30m|2h] [--json]\n       ward device stop [ID|--worktree DIR]");
      // 3, as `ward up`: the folder has no ward, so it has no device of its own either.
      const none = (reason: string) => (console.error(`ward: ${reason}`), void (process.exitCode = 3));
      const ward = find();
      if (ward === undefined) return none(`${flag("worktree") ?? process.cwd()} is not a T3 worktree`);
      await ensureDaemon();
      const result = await call("POST /device", { ...ward, ...(keepMs === undefined ? {} : { keepMs }) }, DEVICE_TIMEOUT_MS);
      if (!result.enabled) return none(result.reason);
      const { serial, state, startedAt } = result.device;
      return console.log(values.json ? JSON.stringify({ serial, state, startedAt }) : serial);
    }
    case "devices": {
      // No auto-start: T3 polls this, and a stopped wardd means no ward has a device.
      const list: DeviceList = existsSync(CONTROL_SOCKET) && (await reachable()) ? await call("GET /devices", {}) : { avds: [], devices: [] };
      if (values.json) return console.log(JSON.stringify(list, null, 2));
      if (list.devices.length === 0) return console.log("no devices");
      for (const d of list.devices) console.log(`${d.serial}\t${d.state}\t${d.ward ?? "(Ward's base image, being built)"}`);
      return;
    }
    case "env":
      process.stdout.write(readFileSync(join(wardRuntimeDir(currentId()), "env"), "utf8"));
      return;
    case "enable":
    case "disable": {
      const repo = repoArg();
      const marker = enabledMarker(repo);
      if (command === "disable") {
        rmSync(marker, { force: true });
        return console.log(`wards disabled for ${repo}`);
      }
      const given = values["host-ports"];
      if (given !== undefined && typeof given !== "string") throw new WardError("usage: ward enable [REPO] --host-ports PORT[,PORT...]");
      const ports = given === undefined ? projectHostPorts(repo) : parseProjectHostPorts(given);
      mkdirSync(join(marker, ".."), { recursive: true });
      writeFileSync(marker, ports.join(","));
      const forwarded = wardHostPorts(ports).join(",");
      console.log(`wards enabled for ${repo}; they reach host ports ${forwarded} (and DNS)`);
      if (given !== undefined) await reportStaleWards(repo, forwarded);
      return;
    }
    case "adb-server": {
      // From shims/adb in a ward started before wards had their own adb server, when the host's isn't answering.
      await ensureDaemon();
      if (!(await call("POST /adb-server", {})).ok) throw new WardError("could not start the host's adb server");
      return;
    }
    case "gc": {
      await ensureDaemon();
      const { actions } = await call("POST /gc", {});
      console.log(actions.length ? actions.join("\n") : "nothing to do");
      return;
    }
    case "images": {
      // Podman's own flags (-q, --quiet, ...) pass through untouched, so not parseArgs' view.
      const raw = process.argv.slice(2);
      const result = spawnSync(join(WARD_HOME, "libexec/ward-images"), raw.slice(raw.indexOf("images") + 1), { stdio: "inherit" });
      process.exitCode = result.status ?? 1;
      return;
    }
    case "install":
      return install();
    case undefined:
    case "help":
    case "--help":
      return console.log(USAGE);
    default:
      throw new WardError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  console.error(`ward: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
