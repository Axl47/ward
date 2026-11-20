// wardd: the user daemon behind every ward. It starts and stops ward units,
// maps each port a ward listens on to a host port in the ward's slot, and runs
// the reconciler that stops or removes wards when T3 is done with them.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { type Server, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BrokerReply, BrokerRequest, PortInfo, Route, Routes, UpResult, WardInfo } from "./api.ts";
import { identify, type Caller } from "./caller.ts";
import {
  ACTIVITY_DIR,
  CONTROL_SOCKET,
  desktopStateDir,
  THREAD_WARDS_DIR,
  desktopUnitName,
  HOST_PORTS,
  isEnabled,
  parsePorts,
  projectHostPorts,
  locate,
  RUNTIME_DIR,
  STATE_DIR,
  T3_HOME,
  threadDesktopId,
  unitName,
  WARD_HOME,
  wardDesktopDir,
  wardRuntimeDir,
  wardStateDir,
  wardTrashDir,
} from "./paths.ts";
import { wardHostPorts } from "./hostports.ts";
import { listeningPorts } from "./procnet.ts";
import { mappedServer, relayToHost, splice } from "./splice.ts";
import { freeSlot, loadRegistry, MAX_SLOTS, saveRegistry, slotPorts, type WardRecord } from "./registry.ts";
import { loadThreads, shouldStop, threadDesktopStep, threadsByWorktree, type ShellThread, type ThreadState } from "./t3state.ts";

const run = promisify(execFile);
const { uid, gid } = userInfo();
const RECONCILE_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const TRASH_DAYS = 7;
// With READY_TIMEOUT_MS, inside the 70 s a client waits for an answer.
const DESKTOP_TIMEOUT_MS = 8_000;

/** A running ward's in-memory plumbing. */
interface LiveWard {
  readonly broker: ChildProcess;
  readonly brokerPid: number;
  /** Ward port → host-side listener. */
  readonly listeners: Map<number, Server>;
  /** Ward port → addresses to dial, from the last socket scan. */
  readonly listening: Map<number, string[]>;
  readonly pending: Map<number, (reply: BrokerReply, socket: Socket | undefined) => void>;
  /** Set once the broker reports it is inside the ward; scanning earlier would read the host's sockets. */
  scanTimer: NodeJS.Timeout | undefined;
  /** Ports the ward's running containers publish, refreshed on each container event. */
  containerPorts: ReadonlySet<number>;
  /** Container id → stops the loop running its healthcheck. */
  readonly health: Map<string, () => void>;
  /** The ward's Podman event stream, while connected. */
  events: ClientRequest | undefined;
  /** A container list request is in flight; another is wanted after it. */
  refreshing: boolean;
  refreshAgain: boolean;
  /** A failed container list is retried, backing off, until one succeeds. */
  refreshRetry: NodeJS.Timeout | undefined;
  refreshFailures: number;
  /** Both sockets of every connection through a mapped port, so detach can reset them. */
  readonly connections: Set<Socket>;
  nextReq: number;
  /** Host ports pasta forwards into the ward; they listen inside it but aren't the ward's own. */
  readonly hostPorts: ReadonlySet<number>;
  /** The host port the broker relays (T3's device daemon), listening inside the ward but not the ward's own. */
  relayPort: number | undefined;
}

const wards = loadRegistry();
const live = new Map<string, LiveWard>();
const locks = new Map<string, Promise<unknown>>();
/** Threads by worktree from the last reconcile, for attributing wards to threads. */
let lastThreads: Map<string, ThreadState[]> | undefined;
const log = (message: string) => console.log(message);

/** Run fn after any earlier operation on the same ward has settled. */
function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(id, next);
  void next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => undefined);
  return next;
}

const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
const isReady = (id: string) => {
  const pid = readPid(id);
  return pid !== undefined && existsSync(join(wardRuntimeDir(id), "ready")) && existsSync(`/proc/${pid}`);
};

function readPid(id: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(wardRuntimeDir(id), "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * When the ward last started, ran a command, or got typing in one of its
 * terminals (ms since epoch). Commands typed into a terminal bypass `ward exec`,
 * so a terminal's last input time (its pty's atime, as `w` uses) counts too.
 */
function lastActivity(id: string): number {
  const times = ["ready", "last-exec"].map((file) => {
    try {
      return statSync(join(wardRuntimeDir(id), file)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return Math.max(...times, ...terminalInputTimes(id));
}

/**
 * The cgroup a ward's commands run in, from the file its start left; a thread's
 * desktop has no such file, and its unit's cgroup is read from the desktop's own
 * process, as bin/ward does. Throws when neither is there.
 */
function cgroupDir(id: string): string {
  const rt = wardRuntimeDir(id);
  if (existsSync(join(rt, "cgroup"))) return readFileSync(join(rt, "cgroup"), "utf8").trim();
  const pid = readFileSync(join(rt, "desktop/pid"), "utf8").trim();
  return `/sys/fs/cgroup${readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split(":")[2]}`;
}

function terminalInputTimes(id: string): number[] {
  let procs: string[];
  try {
    procs = readFileSync(join(cgroupDir(id), "cgroup.procs"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return procs.flatMap((pid) => {
    try {
      // stat through /proc so a terminal that closes meanwhile only drops itself
      return readlinkSync(`/proc/${pid}/fd/0`).startsWith("/dev/pts/") ? [statSync(`/proc/${pid}/fd/0`).atimeMs] : [];
    } catch {
      return [];
    }
  });
}

/**
 * An Android SDK whose platform-tools/adb is Ward's shim and everything else
 * links to the real SDK, so tools that call $ANDROID_HOME/platform-tools/adb
 * directly (React Native, Expo, Gradle) get the `adb reverse` rewrite too.
 */
function sdkOverlay(sdk: string, overlay: string, shim: string): void {
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(join(overlay, "platform-tools"), { recursive: true });
  for (const entry of readdirSync(sdk)) if (entry !== "platform-tools") symlinkSync(join(sdk, entry), join(overlay, entry));
  for (const entry of readdirSync(join(sdk, "platform-tools")))
    symlinkSync(entry === "adb" ? shim : join(sdk, "platform-tools", entry), join(overlay, "platform-tools", entry));
}

/** Write the host ports pasta forwards in, read by ward-init-root; only when the ward starts, since pasta keeps the ones it started with. */
function writeHostPorts(record: WardRecord): void {
  mkdirSync(wardRuntimeDir(record.id), { recursive: true });
  writeFileSync(join(wardRuntimeDir(record.id), "host-ports"), wardHostPorts(projectHostPorts(record.repo)).join(","));
}

/** The env `ward exec` loads; rewritten on every `up` so env changes reach running wards. */
function writeEnvFile(record: WardRecord): void {
  const rt = wardRuntimeDir(record.id);
  const hostPorts = readHostPorts(record.id).join(",");
  const podman = `unix://${rt}/podman/podman.sock`;
  const shims = join(WARD_HOME, "shims");
  const vars: Record<string, string> = {
    WARD_ID: record.id,
    WARD_ROOT: record.worktree,
    WARD_SHIMS: shims,
    DOCKER_HOST: podman,
    CONTAINER_HOST: podman,
    TMPDIR: join(wardStateDir(record.id), "tmp"),
    // BuildKit wants a builder container with its own cgroup, which a ward can't give;
    // the classic builder runs in the ward's Podman.
    DOCKER_BUILDKIT: "0",
    COMPOSE_BAKE: "false",
    // What this ward's pasta forwards, from when it started. Not WARD_HOST_PORTS:
    // that is the global setting, and a `ward` run in the ward would read this as it.
    WARD_FORWARDED_PORTS: hostPorts,
  };
  const sdk = process.env.ANDROID_HOME;
  if (sdk && existsSync(join(sdk, "platform-tools/adb"))) {
    const overlay = join(wardStateDir(record.id), "android-sdk");
    sdkOverlay(sdk, overlay, join(shims, "adb"));
    Object.assign(vars, { ANDROID_HOME: overlay, ANDROID_SDK_ROOT: overlay, WARD_REAL_ADB: join(sdk, "platform-tools/adb") });
  }
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  lines.push(`PATH=${shellQuote(shims)}:"$PATH"`);
  mkdirSync(rt, { recursive: true });
  writeFileSync(join(rt, "env"), lines.join("\n") + "\n");
  // Which worktree owns this id; bin/ward checks it before joining.
  writeFileSync(join(rt, "root"), record.worktree);
}

function info(record: WardRecord): WardInfo {
  const ward = live.get(record.id);
  const ports: PortInfo[] = Object.entries(record.ports)
    .map(([wardPort, host]) => ({ ward: Number(wardPort), host, listening: ward?.listening.has(Number(wardPort)) ?? false }))
    .sort((a, b) => a.ward - b.ward);
  const threadIds = (lastThreads?.get(record.worktree) ?? []).map((t) => t.threadId);
  return { id: record.id, repo: record.repo, worktree: record.worktree, threadIds, slot: record.slot, running: isReady(record.id), ports };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function up(worktree: string): Promise<UpResult> {
  const location = locate(worktree);
  if (location === undefined) return { enabled: false, reason: `${worktree} is not a T3 worktree` };
  if (!isEnabled(location.repo)) return { enabled: false, reason: `wards are not enabled for ${location.repo}` };
  if (!existsSync(location.root)) throw new Error(`${location.root} does not exist`);
  return serialized(location.id, async () => {
    let record = wards.get(location.id);
    if (record !== undefined && record.worktree !== location.root)
      throw new Error(`ward id ${location.id} already belongs to ${record.worktree}; rename one of the folders`);
    // Also when the record exists: wardd may have died between trashing and forgetting it.
    restoreFromTrash(location.id, location.root);
    if (record === undefined) {
      record = { id: location.id, repo: location.repo, worktree: location.root, slot: claimSlot(), ports: {}, createdAt: new Date().toISOString() };
      wards.set(record.id, record);
      saveRegistry(wards);
      log(`created ward ${record.id} in slot ${record.slot}`);
    } else if (record.slot === 0) {
      record = { ...record, slot: claimSlot() };
      wards.set(record.id, record);
      saveRegistry(wards);
      log(`ward ${record.id} got slot ${record.slot}`);
    }
    const starting = !isReady(record.id);
    if (starting) writeHostPorts(record);
    writeEnvFile(record);
    if (starting) {
      await systemctl("start", unitName(record.id));
      await waitReady(record.id);
      log(`started ward ${record.id}`);
      for (const line of initLog(record.id).filter((l) => l.startsWith("ward: warning"))) log(`ward ${record.id}: ${line}`);
    }
    if (!live.has(record.id)) attach(record);
    if (!lastThreads?.has(record.worktree)) void runReconcile(); // learn which threads use it
    return { enabled: true, ward: info(record) };
  });
}

/**
 * Lines the ward's init scripts wrote to stderr in its last start. They go to a
 * file because journald drops what is written from inside the ward's user namespace.
 */
function initLog(id: string): string[] {
  try {
    return readFileSync(join(wardRuntimeDir(id), "init.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const initLogTail = (id: string) => {
  const tail = initLog(id).slice(-15);
  return tail.length ? `:\n${tail.join("\n")}` : `; see \`journalctl --user -u ${unitName(id)}\``;
};

async function waitReady(id: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isReady(id)) return;
    const state = await systemctl("is-active", unitName(id)).then((r) => r.stdout.trim(), (e: { stdout?: string }) => e.stdout?.trim() ?? "unknown");
    if (state === "failed" || state === "inactive") throw new Error(`ward ${id} failed to start${initLogTail(id)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`ward ${id} did not become ready within ${READY_TIMEOUT_MS / 1000}s${initLogTail(id)}`);
}

/**
 * Whether ward id still belongs to worktree (when given). Checked inside the
 * per-id lock: a queued request must not act on a colliding worktree's ward
 * that took over the id meanwhile.
 */
const owns = (id: string, worktree: string | undefined) => worktree === undefined || wards.get(id)?.worktree === worktree;

function stop(id: string, worktree?: string): Promise<boolean> {
  return serialized(id, async () => {
    if (!owns(id, worktree)) return false;
    const wasRunning = isReady(id) || live.has(id);
    detach(id);
    await stopContainers(id);
    await systemctl("stop", unitName(id)).catch(() => undefined);
    if (wasRunning) log(`stopped ward ${id}`);
    return wasRunning;
  });
}

/**
 * Stop a running ward's containers before its unit, with Docker's default 10-second grace
 * period: long enough for a database to shut down cleanly, and short enough that a
 * container ignoring SIGTERM doesn't hold the unit's stop for its whole timeout and
 * leave it failed.
 */
async function stopContainers(id: string): Promise<void> {
  if (!isReady(id)) return;
  await run("podman", ["--url", `unix://${join(wardRuntimeDir(id), "podman/podman.sock")}`, "stop", "--all", "--time", "10"], { timeout: 20_000 }).catch(
    (e: unknown) => log(`ward ${id}: stopping its containers: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`),
  );
}

/**
 * Whether desktop `id` (a ward's, or a thread's) is up: its `env` written, and its
 * `pid` naming a live process of the desktop's own unit, so files anyone could
 * leave in the shared runtime folder don't pass for a desktop that needn't start.
 * bin/ward (ward_desktop_read) also checks what `env` names before using it. A
 * ward's desktop writes its pid as the ward's PID namespace sees it, so it is
 * looked up in the ward's /proc, through the namespace holder; a thread's
 * desktop runs on the host.
 */
function desktopReady(id: string): boolean {
  const dir = wardDesktopDir(id);
  const unit = wards.has(id) ? unitName(id) : desktopUnitName(id);
  try {
    const proc = wards.has(id) ? `/proc/${readPid(id) ?? 0}/root/proc` : "/proc";
    const pid = readFileSync(join(dir, "pid"), "utf8").trim();
    return /^\d+$/.test(pid) && existsSync(join(dir, "env")) && readFileSync(`${proc}/${pid}/cgroup`, "utf8").trim().endsWith(`/${unit}`);
  } catch {
    return false;
  }
}

/** The end of a ward's desktop log. Every program on the desktop writes to it, so only its last 4 KB are read. */
function logTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    const end = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, end, 0, end.length, size - end.length);
    return end.toString("utf8").split("\n").filter(Boolean).slice(-15).join("\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * Start the ward's private desktop (libexec/ward-desktop) unless it is up,
 * starting the ward first if needed. It runs through `ward exec`, so it lives in
 * the ward's namespaces and cgroup and stops with the ward; nothing here stops it.
 */
async function desktop(id: string, worktree?: string): Promise<Record<string, never>> {
  const root = worktree ?? requireRecord(id).worktree;
  const result = await up(root);
  if (!result.enabled) throw new Error(result.reason);
  const ward = result.ward.id;
  return serialized(ward, async () => {
    // Between `up` and here the ward may have been removed, and its id taken by a folder whose name sanitizes alike.
    if (wards.get(ward)?.worktree !== result.ward.worktree) throw new Error(`ward ${ward} changed hands while its desktop was starting; try again`);
    if (desktopReady(ward)) return {};
    // Stopped since `up` answered. `--running` below covers a stop from here on:
    // plain `ward exec` would start the ward again, waiting on this very lock, or
    // run the desktop outside any ward once the project is disabled.
    if (!isReady(ward)) throw new Error(`ward ${ward} was stopped while its desktop was starting; try again`);
    // Emptied, not replaced: the folder is bind-mounted into the ward (libexec/ward-init-root).
    const dir = wardDesktopDir(ward);
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    const name = desktopName(ward);
    // In a file, as init.log is: journald drops what is written from inside the ward's
    // user namespace. With the ward's data and not its runtime folder, because
    // every program the compositor starts writes here, for as long as the ward exists.
    const logFile = join(wardStateDir(ward), "desktop.log");
    const out = openSync(logFile, "a");
    const child = spawn(join(WARD_HOME, "bin/ward"), ["exec", "--running", "--worktree", root, "--", join(WARD_HOME, "libexec/ward-desktop"), ward, name], {
      cwd: root, // where programs the compositor starts (Puck's launch_app) start
      detached: true,
      stdio: ["ignore", out, out],
    });
    closeSync(out);
    child.unref();
    let exited = false;
    const gone = () => {
      exited = true;
      dropDesktopName(name, ward);
    };
    child.once("exit", gone).once("error", gone);
    await desktopUp(ward, `ward ${ward}'s desktop`, logFile, async () => exited, () => {
      // Its own process group (detached), so this takes the bus and compositor with it.
      if (!exited && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    });
    return {};
  });
}

/**
 * A new short name for ward `id`'s desktop folder (see libexec/ward-desktop), as a
 * link in Ward's runtime folder, which the ward itself can't write. Its earlier
 * names go first. The number is random and above any pid, so it never meets the
 * d<pid> name a thread's desktop gives itself, and a command holding an earlier
 * desktop's name can't reach this one.
 */
function desktopName(id: string): string {
  for (const entry of readdirSync(RUNTIME_DIR)) if (/^d\d+$/.test(entry)) dropDesktopName(entry, id);
  for (;;) {
    const name = `d9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    try {
      symlinkSync(`${id}/desktop`, join(RUNTIME_DIR, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Remove the short name `name` if it still names ward `id`'s desktop. */
function dropDesktopName(name: string, id: string): void {
  try {
    if (readlinkSync(join(RUNTIME_DIR, name)) === `${id}/desktop`) unlinkSync(join(RUNTIME_DIR, name));
  } catch {}
}

/** Wait until desktop `id` is up. If it exits first or takes too long, stop it and throw with the end of its log. */
async function desktopUp(id: string, name: string, logFile: string, exited: () => Promise<boolean>, stopIt: () => void | Promise<unknown>): Promise<void> {
  const deadline = Date.now() + DESKTOP_TIMEOUT_MS;
  while (!desktopReady(id)) {
    const gone = await exited();
    if (gone || Date.now() > deadline) {
      await stopIt();
      const tail = logTail(logFile);
      throw new Error(`${name} ${gone ? "failed to start" : `did not start within ${DESKTOP_TIMEOUT_MS / 1000}s`}${tail ? `:\n${tail}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`started ${name}`);
}

/** What the desktop's unit gets from wardd: where Ward keeps things, and where its programs are found. */
const UNIT_ENV = ["PATH", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "WARD_T3_HOME"] as const;

/**
 * Left by a thread's first desktop and never removed: the thread's id. bin/ward
 * restarts a stopped desktop only where it exists, so a thread that once had a
 * private desktop never answers "none" again, whatever T3 lists.
 */
const threadMarker = (id: string) => join(desktopStateDir(id), "thread");

/**
 * Start the private desktop of a T3 thread that has no ward, unless it is up:
 * the same libexec/ward-desktop, in no namespace, as a transient unit of its
 * own, so `ward desktop -- CMD` can join its cgroup and stopping the unit stops
 * everything on it. The reconciler stops it when the thread is done or it sat unused.
 */
function threadDesktop(thread: string, cwd: string): Promise<{ ward?: string }> {
  if (typeof thread !== "string" || thread === "" || typeof cwd !== "string") throw new Error("a thread's desktop needs the thread's id and a folder");
  const id = threadDesktopId(thread);
  return serialized(id, async () => {
    if (desktopReady(id)) return {};
    // A thread of a warded worktree whose shell stands elsewhere: no desktop of its own,
    // its ward's (asked afresh, since a new thread may call before the next reconcile).
    let unwritten: unknown;
    const ward = await withThreads((threads) => {
      const listed = threads.find((t) => t.id === thread);
      try {
        return listed && noteThreadWard(listed);
      } catch (error) {
        unwritten = error;
        return undefined;
      }
    }).catch(() => undefined); // T3 unreachable: its own desktop
    // T3 named its ward but the note couldn't be left: no desktop of its own beside the one Puck looks at.
    if (unwritten !== undefined) throw unwritten;
    if (ward !== undefined) return { ward };
    const unit = desktopUnitName(id);
    const rt = wardRuntimeDir(id);
    const state = desktopStateDir(id);
    await clearThreadDesktop(id); // one whose compositor died, and its app profiles
    mkdirSync(join(state, "tmp"), { recursive: true });
    mkdirSync(rt, { recursive: true });
    writeFileSync(threadMarker(id), thread);
    writeFileSync(join(rt, "last-exec"), "");
    const logFile = join(state, "desktop.log");
    writeFileSync(logFile, "");
    const active = async () => (await systemctl("is-active", unit).catch(() => ({ stdout: "" }))).stdout.trim();
    await run("systemd-run", [
      "--user",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      `--description=Ward desktop of T3 thread ${thread}`,
      // With the wards, under T3's agents slice: what runs here shares the agents' memory limit.
      "--slice=app-t3code-agents-wards.slice",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=15",
      `--property=StandardOutput=append:${logFile}`,
      `--property=StandardError=append:${logFile}`,
      `--working-directory=${existsSync(cwd) ? cwd : "/"}`, // where programs the compositor starts (Puck's launch_app) start
      `--setenv=TMPDIR=${join(state, "tmp")}`,
      ...UNIT_ENV.flatMap((name) => (process.env[name] === undefined ? [] : [`--setenv=${name}=${process.env[name]}`])),
      join(WARD_HOME, "libexec/ward-desktop"),
      id,
    ]);
    try {
      await desktopUp(id, `the desktop of thread ${thread}`, logFile, async () => !["active", "activating"].includes(await active()), () => systemctl("stop", unit).catch(() => undefined));
    } catch (error) {
      rmSync(rt, { recursive: true, force: true });
      throw error;
    }
    return {};
  });
}

/**
 * Stop a thread's desktop, if it runs, and remove its runtime folder, its short
 * names and what apps kept there. Its marker and its last log stay, and the
 * marker's time becomes the desktop's last use, which went with the runtime
 * folder. Call it holding the id's lock.
 */
async function clearThreadDesktop(id: string): Promise<void> {
  const marker = threadMarker(id);
  const before = lastActivity(id); // typing in a terminal counts only while the terminal runs
  await systemctl("stop", desktopUnitName(id)).catch(() => undefined);
  // Read again after the stop: a call may have come in while it ran.
  const used = existsSync(marker) ? Math.max(before, lastActivity(id), statSync(marker).mtimeMs) / 1000 : undefined;
  for (const name of readdirSync(RUNTIME_DIR)) {
    if (!/^d\d+$/.test(name)) continue;
    try {
      if (readlinkSync(join(RUNTIME_DIR, name)) === `${id}/desktop`) unlinkSync(join(RUNTIME_DIR, name));
    } catch {}
  }
  rmSync(wardRuntimeDir(id), { recursive: true, force: true });
  rmSync(join(desktopStateDir(id), "tmp"), { recursive: true, force: true });
  if (used !== undefined) utimesSync(marker, used, used);
}

/**
 * Leaves `thread` its note (bin/ward: ward_thread_note) if T3 gave it a worktree
 * that has a ward, and returns that worktree: the thread then gets the ward's
 * desktop from any folder its shell stands in.
 */
function noteThreadWard(thread: ShellThread): string | undefined {
  const location = thread.worktreePath ? locate(thread.worktreePath) : undefined;
  if (thread.deletedAt || location === undefined || !isEnabled(location.repo) || !existsSync(location.root)) return undefined;
  const note = join(THREAD_WARDS_DIR, threadDesktopId(thread.id));
  const text = `${location.root}\n${thread.id}\n`;
  if (!existsSync(note) || readFileSync(note, "utf8") !== text) {
    mkdirSync(THREAD_WARDS_DIR, { recursive: true });
    writeFileSync(`${note}.tmp`, text);
    renameSync(`${note}.tmp`, note); // bin/ward never sees half a note
  }
  return location.root;
}

/**
 * Thread notes follow T3's list: written for each thread in a warded worktree,
 * and removed once T3 no longer lists the thread with that worktree. One whose
 * ward went away (the worktree removed, the project disabled, the thread
 * deleted but still listed) stays, and bin/ward then gives the thread a desktop
 * of its own. A thread T3 moved off its worktree, or no longer lists, gets the
 * marker of a thread desktop in the note's place, which stays. So a thread that
 * was private never falls to the live session.
 */
function syncThreadNotes(threads: readonly ShellThread[]): void {
  const failed = (what: string, error: unknown) => log(`reconcile: thread note ${what}: ${error instanceof Error ? error.message : String(error)}`);
  for (const thread of threads) {
    try {
      noteThreadWard(thread);
    } catch (error) {
      failed(thread.id, error); // the others still get theirs
    }
  }
  if (!existsSync(THREAD_WARDS_DIR)) return;
  const roots = new Map(threads.map((t) => [t.id, t.worktreePath ? locate(t.worktreePath)?.root : undefined]));
  for (const name of readdirSync(THREAD_WARDS_DIR)) {
    const note = join(THREAD_WARDS_DIR, name);
    try {
      if (name.endsWith(".tmp")) {
        rmSync(note, { force: true }); // left by a write that was cut off; none is under way now
        continue;
      }
      const [root, thread] = readFileSync(note, "utf8").split("\n");
      if (thread !== undefined && roots.get(thread) === root) continue;
      // The marker keeps its plain asks private from now on, as it does for any thread that had a desktop.
      if (thread !== undefined && !existsSync(threadMarker(name))) {
        mkdirSync(desktopStateDir(name), { recursive: true });
        writeFileSync(threadMarker(name), thread);
      }
      rmSync(note, { force: true });
    } catch (error) {
      failed(name, error); // it stays for the next pass; the others still get their turn
    }
  }
}

let waiting: { got: (threads: readonly ShellThread[]) => void; failed: (error: unknown) => void }[] = [];
let fetching = false;
/**
 * T3's thread list, one fetch at a time: everyone who asks while a fetch runs
 * shares the next one, and each answer is handed to its callers (`use`) before
 * the next fetch starts. Notes are written and removed only in `use`, so a list
 * fetched earlier never undoes what a later one wrote, and a stalled T3 costs a
 * caller two timeouts at most.
 */
function withThreads<T>(use: (threads: readonly ShellThread[]) => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push({
      got: (threads) => {
        try {
          resolve(use(threads));
        } catch (error) {
          reject(error);
        }
      },
      failed: reject,
    });
    if (!fetching) void fetchThreads();
  });
}

async function fetchThreads(): Promise<void> {
  fetching = true;
  while (waiting.length > 0) {
    const callers = waiting;
    waiting = [];
    await loadThreads().then(
      (threads) => callers.forEach((caller) => caller.got(threads)),
      (error: unknown) => callers.forEach((caller) => caller.failed(error)),
    );
  }
  fetching = false;
}

/**
 * Thread desktops: stop or tidy each as threadDesktopStep says, and clear away
 * those that died. A stopped desktop comes back, empty, when its thread next
 * asks. The marker always stays (threadMarker).
 */
async function reconcileThreadDesktops(threads: readonly ShellThread[] | undefined, now: number): Promise<string[]> {
  const actions: string[] = [];
  const kept = join(STATE_DIR, "desktops");
  const ids = new Set([...readdirSync(RUNTIME_DIR), ...(existsSync(kept) ? readdirSync(kept) : [])]);
  for (const id of ids) {
    // A thread desktop's id has no dot; a ward's (whose repo may be named t-…) has one.
    if (!/^t-[A-Za-z0-9_-]+$/.test(id) || locks.has(id)) continue;
    await serialized(id, async () => {
      const marker = threadMarker(id);
      const thread = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
      const running = thread !== undefined && desktopReady(id);
      const died = !running && (existsSync(wardRuntimeDir(id)) || existsSync(join(desktopStateDir(id), "tmp")));
      if (died) await clearThreadDesktop(id);
      if (thread === undefined) return rmSync(desktopStateDir(id), { recursive: true, force: true }); // left by a start that never finished
      if (threads === undefined) return; // T3 unreachable: leave it as it is
      const step = threadDesktopStep(threads.find((t) => t.id === thread), running, died, Math.max(lastActivity(id), statSync(marker).mtimeMs), now);
      if (step === undefined) return;
      if (step === "drop log") return rmSync(join(desktopStateDir(id), "desktop.log"), { force: true });
      await clearThreadDesktop(id);
      actions.push(`stopped the desktop of thread ${thread}: ${step}`);
    }).catch((error: unknown) => log(`reconcile: thread desktop ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }
  return actions;
}

/** A free slot, else the slot of the stopped ward unused the longest. */
function claimSlot(): number {
  const slot = freeSlot(wards);
  if (slot !== undefined) return slot;
  const victim = [...wards.values()]
    .filter((w) => w.slot > 0 && !isReady(w.id) && !locks.has(w.id))
    .sort((a, b) => lastActivity(a.id) - lastActivity(b.id))[0];
  if (victim === undefined) throw new Error(`all ${MAX_SLOTS} ward slots are held by running wards; stop some with \`ward stop\``);
  wards.set(victim.id, { ...victim, slot: 0, ports: {} });
  log(`ward ${victim.id}: gave its slot ${victim.slot} to a new ward`);
  return victim.slot;
}

const purge = (...targets: string[]) => run(join(WARD_HOME, "libexec/ward-purge"), targets);

/**
 * Remove a ward. With trash, its data moves to the trash for TRASH_DAYS and
 * comes back if the same worktree reappears; otherwise it is deleted now.
 */
function rm(id: string, { trash = false, worktree }: { trash?: boolean; worktree?: string } = {}): Promise<boolean> {
  return serialized(id, async () => {
    if (!owns(id, worktree)) return false;
    detach(id);
    await stopContainers(id);
    await systemctl("stop", unitName(id)).catch(() => undefined);
    const recorded = wards.get(id)?.worktree;
    if (trash && recorded !== undefined && existsSync(wardStateDir(id))) {
      const dest = wardTrashDir(id, recorded);
      await purge(`trash/${basename(dest)}`);
      mkdirSync(dirname(dest), { recursive: true });
      const now = new Date();
      utimesSync(wardStateDir(id), now, now); // the trash clock starts now, even if wardd dies mid-move
      renameSync(wardStateDir(id), dest);
    } else if (!trash && recorded !== undefined) {
      await purge(`trash/${basename(wardTrashDir(id, recorded))}`); // a copy left by a crash mid-trash
    }
    await purge(`wards/${id}`, `runtime/${id}`);
    const existed = wards.delete(id);
    saveRegistry(wards);
    if (existed) log(`removed ward ${id}${trash ? " (data in trash)" : ""}`);
    return existed;
  });
}

function restoreFromTrash(id: string, root: string): void {
  const trashed = wardTrashDir(id, root);
  if (!existsSync(trashed) || existsSync(wardStateDir(id))) return;
  mkdirSync(dirname(wardStateDir(id)), { recursive: true });
  renameSync(trashed, wardStateDir(id));
  log(`ward ${id}: restored its data from the trash`);
}

async function purgeOldTrash(): Promise<string[]> {
  const dir = join(STATE_DIR, "trash");
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  const old = readdirSync(dir).filter((name) => statSync(join(dir, name)).mtimeMs < cutoff);
  if (old.length > 0) await purge(...old.map((name) => `trash/${name}`));
  return old.map((name) => `purged ${name} from the trash`);
}

// ── Port mapping ─────────────────────────────────────────────────────────────

function attach(record: WardRecord): void {
  const pid = readPid(record.id);
  if (pid === undefined) return;
  const broker = spawn(
    "nsenter",
    ["-U", "-n", "-t", String(pid), "--setuid", String(uid), "--setgid", String(gid), "--",
      process.execPath, join(WARD_HOME, "src/broker.js")],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  if (broker.pid === undefined) return;
  // The broker holds the ward's network namespace open, so it must die with the ward.
  try {
    writeFileSync(join(readFileSync(join(wardRuntimeDir(record.id), "cgroup"), "utf8").trim(), "cgroup.procs"), String(broker.pid));
  } catch (error) {
    log(`ward ${record.id}: could not move broker into the ward's cgroup: ${String(error)}`);
  }
  const ward: LiveWard = {
    broker,
    brokerPid: broker.pid,
    listeners: new Map(),
    listening: new Map(),
    pending: new Map(),
    scanTimer: undefined,
    containerPorts: new Set(),
    health: new Map(),
    events: undefined,
    refreshing: false,
    refreshAgain: false,
    refreshRetry: undefined,
    refreshFailures: 0,
    connections: new Set(),
    nextReq: 1,
    hostPorts: new Set([53, ...readHostPorts(record.id)]),
    relayPort: undefined,
  };
  live.set(record.id, ward);
  broker.on("message", (reply: BrokerReply, socket: unknown) => {
    if (reply.t === "ready") {
      if (ward.scanTimer !== undefined) return;
      ward.scanTimer = setInterval(() => void scan(record.id), 1000);
      watchContainers(record.id, ward);
      relayDeviceDaemon(ward);
      return void scan(record.id);
    }
    const upstream = socket instanceof Object && "pipe" in socket ? (socket as Socket) : undefined;
    if (reply.t === "accepted") {
      if (upstream === undefined) return;
      return relayToHost(upstream, reply.port, (s) => {
        ward.connections.add(s);
        s.once("close", () => ward.connections.delete(s));
      });
    }
    const callback = ward.pending.get(reply.req);
    ward.pending.delete(reply.req);
    if (callback === undefined) return void upstream?.destroy(); // its client timed out meanwhile
    callback(reply, upstream);
  });
  broker.on("exit", () => {
    if (live.get(record.id) === ward) detach(record.id);
  });
}

/** The host ports a ward was started with. */
function readHostPorts(id: string): readonly number[] {
  try {
    return parsePorts(readFileSync(join(wardRuntimeDir(id), "host-ports"), "utf8"));
  } catch {
    return HOST_PORTS;
  }
}

function detach(id: string): void {
  const ward = live.get(id);
  if (ward === undefined) return;
  live.delete(id);
  clearInterval(ward.scanTimer);
  clearTimeout(ward.refreshRetry);
  ward.events?.destroy();
  // A reset, not a clean end: a client must not take a cut-off download for a complete one.
  for (const socket of ward.connections) {
    try {
      socket.resetAndDestroy();
    } catch {
      socket.destroy();
    }
  }
  for (const stopHealthcheck of ward.health.values()) stopHealthcheck();
  for (const server of ward.listeners.values()) server.close();
  for (const callback of ward.pending.values()) callback({ t: "failed", req: 0, message: "ward stopped" }, undefined);
  ward.broker.kill();
}

/**
 * Find the ward's ports: TCP sockets listening on its loopback or wildcard
 * addresses (from the broker's view of /proc/net), plus ports its containers
 * publish (Podman forwards those with firewall rules, not listening sockets).
 * Resolves once newly found ports have host listeners.
 */
function scan(id: string): Promise<unknown> {
  const ward = live.get(id);
  if (ward?.scanTimer === undefined) return Promise.resolve(); // broker not in the ward yet
  const found = new Map<number, string[]>();
  for (const file of ["tcp", "tcp6"] as const) {
    let text: string;
    try {
      text = readFileSync(`/proc/${ward.brokerPid}/net/${file}`, "utf8");
    } catch {
      return Promise.resolve(); // broker gone; its exit handler detaches the ward
    }
    for (const [port, hosts] of listeningPorts(text)) {
      if (!ward.hostPorts.has(port) && port !== ward.relayPort) found.set(port, [...new Set([...(found.get(port) ?? []), ...hosts])]);
    }
  }
  for (const port of ward.containerPorts) if (!found.has(port)) found.set(port, ["127.0.0.1"]);
  ward.listening.clear();
  // Close listeners whose port went quiet, so the host sees "refused", not accept-then-reset.
  // The registry keeps the port number for when it listens again.
  for (const [port, server] of ward.listeners) {
    if (found.has(port)) continue;
    server.close();
    ward.listeners.delete(port);
  }
  const mapping: Promise<unknown>[] = [];
  for (const [port, hosts] of found) {
    ward.listening.set(port, hosts);
    if (!ward.listeners.has(port)) mapping.push(ensureListener(id, port).catch((e: unknown) => log(`ward ${id}: port ${port}: ${String(e)}`)));
  }
  return Promise.all(mapping);
}

/** One entry of Podman's own container list (not the Docker-compatible one, which omits health). */
interface PodmanContainer {
  readonly Id: string;
  /** Health: "starting", "healthy" or "unhealthy"; empty without a healthcheck. */
  readonly Status?: string;
  readonly Ports?: ReadonlyArray<{
    readonly host_ip?: string;
    readonly host_port?: number;
    readonly range?: number;
    readonly protocol?: string;
  }> | null;
}

/**
 * GET a path on the ward's Podman API; onBody gets the body of a 200 reply.
 * Resolves true once onBody ran without throwing, false on any failure. Never rejects.
 */
function podmanRequest(id: string, path: string, onBody?: (body: string) => void, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ socketPath: join(wardRuntimeDir(id), "podman/podman.sock"), path, timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          onBody?.(data);
          resolve(true);
        } catch (error) {
          log(`ward ${id}: unexpected Podman reply for ${path}: ${String(error)}`);
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("close", () => resolve(false)); // also when Podman hangs up mid-reply; no-op after a resolve
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** Delay before retry n (1-based) of a failed Podman request: 1, 2, 4, … capped at 30 s. */
const retryMs = (n: number) => Math.min(1000 * 2 ** (n - 1), 30_000);

const DEFAULT_HEALTH_MS = 30_000; // Podman's default interval and timeout
const nsToMs = (ns: unknown) => (typeof ns === "number" && ns > 0 ? ns / 1e6 : DEFAULT_HEALTH_MS);
/** Container events that can change what is running, what it publishes, or what needs a healthcheck. */
const CONTAINER_CHANGES = new Set(["start", "died", "remove"]);

/**
 * Follow the ward's Podman events and refresh the container list on each change,
 * so nothing polls Podman while its containers stay as they are. Lists once on
 * each (re)connect: Podman sends the stream's headers only with its first event,
 * so the list can't wait for them; the `since` replay covers the gap. Reconnects
 * while the ward is live.
 */
function watchContainers(id: string, ward: LiveWard): void {
  if (live.get(id) !== ward) return;
  const filters = encodeURIComponent(JSON.stringify({ type: ["container"] }));
  // Replays the last moments too, so a container that starts around the first list isn't missed.
  const since = Math.floor(Date.now() / 1000) - 1;
  const req = httpRequest({ socketPath: join(wardRuntimeDir(id), "podman/podman.sock"), path: `/v4.0.0/libpod/events?stream=true&since=${since}&filters=${filters}`,
    // A connection of its own, so "connect" fires: a reused keep-alive socket would never clear the timer.
    agent: false }, (res) => {
    let pending = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      const changed = lines.filter((line) => {
        try {
          const event = JSON.parse(line) as { Action?: string; Actor?: { ID?: string } };
          // A restarted container keeps its id; its first check is due at once, not an interval later.
          if (event.Action === "start" && event.Actor?.ID !== undefined) {
            ward.health.get(event.Actor.ID)?.();
            ward.health.delete(event.Actor.ID);
          }
          return CONTAINER_CHANGES.has(event.Action ?? "");
        } catch {
          return line.trim() !== "";
        }
      }).length > 0;
      if (changed) refreshContainers(id, ward);
    });
  });
  // Only for connecting: once connected, an idle stream legitimately stays silent.
  const stalled = setTimeout(() => req.destroy(), 5000);
  req.on("socket", (socket) => socket.once("connect", () => clearTimeout(stalled)));
  req.on("error", () => undefined); // "close" follows and reconnects
  req.on("close", () => {
    clearTimeout(stalled);
    if (ward.events === req) ward.events = undefined;
    setTimeout(() => watchContainers(id, ward), 1000);
  });
  ward.events = req;
  req.end();
  refreshContainers(id, ward);
}

/** Re-read the ward's containers: published ports and healthchecks. Coalesces overlapping calls. */
function refreshContainers(id: string, ward: LiveWard): void {
  if (ward.refreshing) return void (ward.refreshAgain = true);
  ward.refreshing = true;
  clearTimeout(ward.refreshRetry);
  ward.refreshRetry = undefined;
  void podmanRequest(id, "/v4.0.0/libpod/containers/json", (data) => {
    const containers = JSON.parse(data) as PodmanContainer[];
    if (!Array.isArray(containers) || live.get(id) !== ward) return;
    ward.containerPorts = new Set(
      containers.flatMap((c) =>
        (c.Ports ?? [])
          .filter((p) => p.protocol === "tcp" && p.host_port !== undefined && ["", "0.0.0.0", "127.0.0.1", "::"].includes(p.host_ip ?? ""))
          .flatMap((p) => Array.from({ length: p.range ?? 1 }, (_, i) => p.host_port! + i)),
      ),
    );
    trackHealthchecks(id, ward, containers);
    void scan(id);
  }).then((ok) => {
    ward.refreshing = false;
    if (live.get(id) !== ward) return;
    // Podman may be busy (a `compose up`): until a list succeeds, published ports stay unmapped.
    ward.refreshFailures = ok ? 0 : ward.refreshFailures + 1;
    if (ward.refreshAgain) {
      ward.refreshAgain = false;
      refreshContainers(id, ward);
    } else if (!ok) {
      ward.refreshRetry = setTimeout(() => refreshContainers(id, ward), retryMs(ward.refreshFailures));
    }
  });
}

/**
 * Podman schedules healthchecks with systemd timers, which a ward doesn't have, so
 * wardd runs each container's check in a loop of its own: the first right away,
 * then each its configured interval after the previous one finished, as Docker
 * does. Compose's `depends_on: service_healthy` and `up --wait` rely on this.
 */
function trackHealthchecks(id: string, ward: LiveWard, containers: readonly PodmanContainer[]): void {
  const checked = new Set(containers.filter((c) => c.Status === "starting" || c.Status === "healthy" || c.Status === "unhealthy").map((c) => c.Id));
  for (const [container, stopHealthcheck] of ward.health) {
    if (checked.has(container)) continue;
    stopHealthcheck();
    ward.health.delete(container);
  }
  for (const container of checked) {
    if (ward.health.has(container)) continue;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const stopHealthcheck = () => {
      stopped = true;
      clearTimeout(timer);
    };
    ward.health.set(container, stopHealthcheck);
    let intervalMs = DEFAULT_HEALTH_MS;
    let timeoutMs = DEFAULT_HEALTH_MS;
    const run = () => {
      if (stopped) return;
      void podmanRequest(id, `/v4.0.0/libpod/containers/${container}/healthcheck`, undefined, timeoutMs + 5000).then(() => {
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
    };
    // The interval and timeout come from an inspect, retried until it succeeds.
    const inspect = (attempt: number) => {
      if (stopped) return;
      void podmanRequest(id, `/v4.0.0/libpod/containers/${container}/json`, (body) => {
        const check = (JSON.parse(body) as { Config?: { Healthcheck?: { Interval?: unknown; Timeout?: unknown } } }).Config?.Healthcheck;
        intervalMs = nsToMs(check?.Interval);
        timeoutMs = nsToMs(check?.Timeout);
      }).then((ok) => {
        if (ok) run();
        else if (!stopped) timer = setTimeout(() => inspect(attempt + 1), retryMs(attempt));
      });
    };
    inspect(1);
  }
}

/** Make sure a host listener exists for a ward port; returns its host port. */
async function ensureListener(id: string, wardPort: number): Promise<number> {
  const ward = live.get(id);
  const record = wards.get(id);
  if (ward === undefined || record === undefined) throw new Error(`ward ${id} is not running`);
  const existing = ward.listeners.get(wardPort);
  const known = record.ports[String(wardPort)];
  if (existing !== undefined && known !== undefined) return known;

  const taken = new Set(Object.values(record.ports));
  const candidates = [...(known === undefined ? [] : [known]), ...slotPorts(record.slot).filter((p) => !taken.has(p))];
  for (const hostPort of candidates) {
    const server = mappedServer((socket) => forward(id, wardPort, socket));
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(hostPort, "127.0.0.1", () => resolve(true));
    });
    if (!ok) {
      const won = ward.listeners.has(wardPort) ? wards.get(id)?.ports[String(wardPort)] : undefined;
      if (won !== undefined) return won; // a concurrent call mapped it meanwhile
      continue;
    }
    if (live.get(id) !== ward || ward.listeners.has(wardPort)) {
      server.close(); // lost a race with detach or another ensureListener
      return ward.listeners.has(wardPort) ? (wards.get(id) ?? record).ports[String(wardPort)]! : hostPort;
    }
    ward.listeners.set(wardPort, server);
    if (known !== hostPort) {
      const current = wards.get(id) ?? record; // re-read: other mappings may have landed meanwhile
      wards.set(id, { ...current, ports: { ...current.ports, [String(wardPort)]: hostPort } });
      saveRegistry(wards);
      log(`ward ${id}: port ${wardPort} → 127.0.0.1:${hostPort}`);
    }
    return hostPort;
  }
  // The block is full: release one mapping whose ward port is no longer listening.
  const stale = Object.keys(record.ports).map(Number).find((p) => p !== wardPort && !ward.listening.has(p));
  if (stale === undefined) throw new Error(`all ${slotPorts(record.slot).length} host ports of slot ${record.slot} are in use`);
  ward.listeners.get(stale)?.close();
  ward.listeners.delete(stale);
  const current = wards.get(id) ?? record;
  const { [String(stale)]: _released, ...ports } = current.ports;
  wards.set(id, { ...current, ports });
  saveRegistry(wards);
  log(`ward ${id}: released port ${stale} (not listening) to make room`);
  return ensureListener(id, wardPort);
}

function forward(id: string, wardPort: number, client: Socket): void {
  const ward = live.get(id);
  if (ward === undefined) return void client.destroy();
  const req = ward.nextReq++;
  const timer = setTimeout(() => {
    ward.pending.delete(req);
    client.destroy();
  }, CONNECT_TIMEOUT_MS);
  ward.pending.set(req, (reply, upstream) => {
    clearTimeout(timer);
    if (reply.t !== "connected" || upstream === undefined) return void client.destroy();
    for (const socket of [client, upstream]) {
      ward.connections.add(socket);
      socket.once("close", () => ward.connections.delete(socket));
    }
    splice(client, upstream);
  });
  const message: BrokerRequest = { t: "connect", req, port: wardPort, hosts: ward.listening.get(wardPort) ?? ["127.0.0.1", "::1"] };
  ward.broker.send(message);
}

// ── T3's device daemon ───────────────────────────────────────────────────────

/**
 * T3's device daemon (agent-device) listens on a new random port each time it
 * starts, and its CLI dials 127.0.0.1 at the port daemon.json names. pasta's
 * forwards are fixed when a ward starts, so the broker relays that port instead,
 * moved whenever daemon.json changes.
 */
const DEVICE_DAEMON_FILE = join(T3_HOME, "userdata/device/agent-device/daemon.json");
let devicePort = readDevicePort();
let deviceWatcher: FSWatcher | undefined;

function readDevicePort(): number | undefined {
  try {
    const { httpPort } = JSON.parse(readFileSync(DEVICE_DAEMON_FILE, "utf8")) as { httpPort?: unknown };
    return typeof httpPort === "number" && Number.isInteger(httpPort) && httpPort > 0 && httpPort < 65536 ? httpPort : undefined;
  } catch {
    return undefined; // no daemon yet, or T3 is mid-write; the watcher reads it again
  }
}

/** Point a ward's relay at the device daemon's current port; ports pasta already forwards need none. */
function relayDeviceDaemon(ward: LiveWard): void {
  const port = devicePort !== undefined && !ward.hostPorts.has(devicePort) ? devicePort : undefined;
  if (ward.scanTimer === undefined || ward.relayPort === port) return;
  if (ward.relayPort !== undefined) ward.broker.send({ t: "unrelay", port: ward.relayPort } satisfies BrokerRequest);
  ward.relayPort = port;
  if (port !== undefined) ward.broker.send({ t: "relay", port } satisfies BrokerRequest);
}

/** Follow daemon.json; called on every reconcile, so a folder that appears later is watched too. */
function watchDeviceDaemon(): void {
  const refresh = () => {
    devicePort = readDevicePort();
    for (const ward of live.values()) relayDeviceDaemon(ward);
  };
  refresh();
  if (deviceWatcher !== undefined || !existsSync(dirname(DEVICE_DAEMON_FILE))) return;
  let soon: NodeJS.Timeout | undefined;
  deviceWatcher = watch(dirname(DEVICE_DAEMON_FILE), (_event, name) => {
    if (name !== basename(DEVICE_DAEMON_FILE)) return;
    clearTimeout(soon);
    soon = setTimeout(refresh, 100);
  });
  deviceWatcher.on("error", () => (deviceWatcher?.close(), (deviceWatcher = undefined)));
}

/** The host's adb, which T3's device tools use too: the server must be the same version as every client. */
const HOST_ADB = join(process.env.ANDROID_HOME ?? join(homedir(), "Android/Sdk"), "platform-tools/adb");

// ── Reconciler ───────────────────────────────────────────────────────────────

/**
 * Trash wards whose worktree is gone (data is kept TRASH_DAYS), re-attach
 * running wards wardd lost track of, and stop wards no thread needs (see
 * shouldStop).
 */
async function reconcile(): Promise<string[]> {
  watchDeviceDaemon();
  const actions: string[] = [];
  let threads: Map<string, ThreadState[]> | undefined;
  let allThreads: readonly ShellThread[] | undefined;
  try {
    allThreads = await withThreads((list) => {
      try {
        syncThreadNotes(list);
      } catch (error) {
        log(`reconcile: thread notes: ${error instanceof Error ? error.message : String(error)}`);
      }
      return list;
    });
    threads = lastThreads = threadsByWorktree(allThreads);
  } catch (error) {
    log(`reconcile: cannot read T3 thread state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const now = Date.now();
  for (const record of [...wards.values()]) {
    if (!existsSync(record.worktree)) {
      // No worktrees folder at all means it was moved or unmounted, not that worktrees were removed.
      if (!existsSync(dirname(dirname(record.worktree)))) continue;
      if (await rm(record.id, { trash: true, worktree: record.worktree }))
        actions.push(`removed ${record.id}: worktree is gone (data kept in the trash for ${TRASH_DAYS} days)`);
      continue;
    }
    if (!isReady(record.id)) continue;
    // Its broker died, or it came up while wardd was down; not while a stop or rm holds it.
    if (!live.has(record.id) && !locks.has(record.id)) attach(record);
    // T3 unreachable: leave running wards alone.
    if (threads === undefined || !shouldStop(threads.get(record.worktree) ?? [], lastActivity(record.id), now)) continue;
    if (await stop(record.id, record.worktree)) actions.push(`stopped ${record.id}: no active thread needs it`);
  }
  actions.push(...(await reconcileThreadDesktops(allThreads, now)));
  actions.push(...(await purgeOldTrash()));
  return actions;
}

/** Watch each repo folder of warded worktrees so removals are noticed in seconds. */
const watchers = new Map<string, FSWatcher>();
let reconcileSoon: NodeJS.Timeout | undefined;
function watchWorktreeParents(): void {
  const parents = new Set([...wards.values()].map((w) => dirname(w.worktree)));
  for (const [dir, watcher] of watchers) if (!parents.has(dir)) (watcher.close(), watchers.delete(dir));
  for (const dir of parents) {
    if (watchers.has(dir) || !existsSync(dir)) continue;
    const watcher = watch(dir, () => {
      clearTimeout(reconcileSoon);
      reconcileSoon = setTimeout(() => void runReconcile(), 2000);
    });
    watcher.on("error", () => (watcher.close(), watchers.delete(dir)));
    watchers.set(dir, watcher);
  }
}

let reconciling: Promise<string[]> | undefined;
function runReconcile(): Promise<string[]> {
  reconciling ??= reconcile()
    .then((actions) => (actions.forEach(log), actions))
    .finally(() => {
      reconciling = undefined;
      watchWorktreeParents();
    });
  return reconciling;
}

// ── Control socket ───────────────────────────────────────────────────────────

type Handlers = { [R in Route]: (body: Routes[R]["body"]) => Promise<Routes[R]["result"]> };

/** The ward with this id; with worktree, only if it is that worktree's (ids of similar folder names can collide). */
const requireRecord = (id: string, worktree?: string) => {
  const record = wards.get(id);
  if (record === undefined || (worktree !== undefined && record.worktree !== worktree))
    throw new Error(`no ward for ${worktree ?? id}`);
  return record;
};

const handlers: Handlers = {
  "POST /up": ({ worktree }) => up(worktree).finally(watchWorktreeParents),
  "POST /stop": async ({ id, worktree }) => ({ stopped: await stop(requireRecord(id, worktree).id, worktree) }),
  "POST /rm": async ({ id, worktree, now }) => ({ removed: await rm(requireRecord(id, worktree).id, { trash: !now, ...(worktree === undefined ? {} : { worktree }) }) }),
  "POST /port": async ({ id, port }) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
    requireRecord(id);
    return { host: await ensureListener(id, port) };
  },
  "POST /desktop": (body) => ("thread" in body ? threadDesktop(body.thread, body.cwd) : desktop(body.id, body.worktree).finally(watchWorktreeParents)),
  "POST /gc": async () => ({ actions: await runReconcile() }),
  "POST /adb-server": async () => ({ ok: await run(HOST_ADB, ["start-server"], { timeout: 30_000 }).then(() => true, () => false) }),
  "GET /ls": async () => {
    await Promise.all([...live.keys()].map(scan)); // what listens now, not at the last scan
    return [...wards.values()].map(info).sort((a, b) => a.slot - b.slot);
  },
};

/**
 * What a caller inside a ward may ask, always about its own ward (`id`, from
 * its network namespace): map a port, start its desktop, start the host's adb
 * server (bin/ward, shims/adb), and list itself (`ward ports`). Everything
 * else, and any other ward's id, is the host's alone.
 */
const wardHandlers: { [R in Route]?: (id: string, body: Routes[R]["body"]) => Promise<Routes[R]["result"]> } = {
  "POST /port": (id, body) => {
    if (body.id !== id) throw new Forbidden(`a ward can map only its own ports, not ${body.id}'s`);
    return handlers["POST /port"](body);
  },
  "POST /desktop": (id, body) => {
    if ("thread" in body || body.id !== id || (body.worktree !== undefined && body.worktree !== wards.get(id)?.worktree))
      throw new Forbidden("a ward can start only its own desktop");
    return handlers["POST /desktop"]({ id });
  },
  "POST /adb-server": (_id, body) => handlers["POST /adb-server"](body),
  "GET /ls": async (id, body) => (await handlers["GET /ls"](body)).filter((w) => w.id === id),
};

class Forbidden extends Error {}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Each connection's caller, looked up once: a keep-alive client sends several requests on one. */
const callers = new WeakMap<object, Caller | undefined>();
function callerOf(req: IncomingMessage): Caller | undefined {
  if (!callers.has(req.socket)) callers.set(req.socket, identify(req.socket, [...wards.keys()].map((id) => [id, readPid(id)] as const)));
  return callers.get(req.socket);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = `${req.method} ${req.url}`;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!(route in handlers)) return reply(404, { error: `unknown route ${route}` });
  const caller = callerOf(req);
  if (caller === undefined) return reply(403, { error: "wardd answers only the host and its wards" });
  let handler: (body: unknown) => Promise<unknown>;
  if (caller.kind === "host") handler = handlers[route as Route] as (body: unknown) => Promise<unknown>;
  else {
    const forWard = wardHandlers[route as Route] as ((id: string, body: unknown) => Promise<unknown>) | undefined;
    if (forWard === undefined) return reply(403, { error: `${route} is not available inside a ward` });
    handler = (body) => forWard(caller.id, body);
  }
  try {
    reply(200, await handler(await readBody(req)));
  } catch (error) {
    reply(error instanceof Forbidden ? 403 : 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function main(): void {
  mkdirSync(dirname(CONTROL_SOCKET), { recursive: true });
  // Before any ward starts: a ward hides the folder only if it exists by then.
  mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  rmSync(CONTROL_SOCKET, { force: true });
  const server = createHttpServer((req, res) => void handle(req, res));
  server.listen(CONTROL_SOCKET, () => log(`wardd listening on ${CONTROL_SOCKET}`));
  for (const record of wards.values()) {
    if (isReady(record.id)) attach(record);
  }
  watchWorktreeParents();
  void runReconcile();
  setInterval(() => void runReconcile(), RECONCILE_MS);
  const shutdown = () => {
    // Wards keep running; a restarted wardd re-attaches to them.
    for (const id of [...live.keys()]) detach(id);
    try {
      unlinkSync(CONTROL_SOCKET);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) main();
