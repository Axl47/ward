// Each ward's own Android device (docs/DESIGN.md: Devices): a read-only instance
// of one base AVD that Ward builds and keeps, started on the host on first use.
// Read-only instances write to temporary overlays, so any number run from one
// image, each starts from its boot snapshot in seconds, and stopping one leaves
// nothing behind: the next is fresh.
//
// A device runs as a transient unit, so it outlives a wardd restart; what wardd
// needs to find it again is in `device.json` in the device's folder. Nothing here
// is inside a ward: an emulator there would bind its ports where the host's adb
// server, and so T3, can't see them. How a ward reaches its device is wardd's
// (src/daemon.ts: Devices) and src/adb.ts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeviceInfo, DeviceList } from "./api.ts";
import { DEVICE_DIR, deviceUnitName } from "./paths.ts";

const run = promisify(execFile);
const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.log(message);

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Android/Sdk");
/** The SDK's adb: the host's server, which T3's device tools use, and each ward's own are this one, as their clients are. */
export const HOST_ADB = join(SDK, "platform-tools/adb");
/** Ward's own AVD home: its base images aren't among yours, so nothing else lists or boots them. */
const AVD_HOME = join(DEVICE_DIR, "avd");
/** Where your AVDs are; one of them is the template a base image copies its hardware from. */
const USER_AVD_HOME = process.env.ANDROID_AVD_HOME ?? join(homedir(), ".android/avd");
const GPU = process.env.WARD_DEVICE_GPU ?? "swangle_indirect";
/** Change it when the way a base image is built changes, so every base is rebuilt. */
const RECIPE = "2"; // 2: built off every adb server, so an image built before, which a host install could have reached, is replaced
const BASE_UNIT = deviceUnitName("base"); // no ward's: a ward's id has a dot
/**
 * Console ports ward devices take, highest first. The adb server finds emulators
 * on 5554 to 5584 by itself, also after it restarts, and an emulator started
 * without a port takes the lowest free one, so yours and Ward's meet last.
 */
const PORTS = Array.from({ length: 13 }, (_, i) => 5584 - 2 * i);
/**
 * Console ports a base image build may take (its adb port is the next), above the
 * range adb servers scan, so no adb server ever finds it. Each is also paired with
 * the port the emulator is told the adb server is on (+ BASE_ADB_SERVER_OFFSET),
 * free when the build starts, so it never announces itself to the host's.
 */
const BASE_PORTS = [5690, 5692, 5694];
const BASE_ADB_SERVER_OFFSET = 100;
/**
 * The emulator runs an adb command of its own once Android is up, which starts an
 * adb server on that port, in the build's unit, gone with it. This keeps that
 * server from finding anything but the base image: no USB, no mDNS, and no scan
 * of the ports emulators are on.
 */
const BASE_ADB_ENV = { ADB_USB: "0", ADB_MDNS: "0", ADB_LOCAL_TRANSPORT_MAX_PORT: "5553" };

/** "90s", "15m" or "2h" in milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)([smh])$/.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
}

/** How long a device may go unused before the reconciler stops it. */
const IDLE_MS = parseDuration(process.env.WARD_DEVICE_IDLE ?? "") ?? 15 * 60_000;
/** How many devices run at once: each holds about 3.6 GB of memory. */
const MAX = Math.max(1, Math.floor(Number(process.env.WARD_DEVICE_MAX)) || 8);
/**
 * How long a device must have gone unused before another ward may take its place.
 * Longer than the 5 minutes between T3's keep-alives, so a device with an open T3
 * session is never taken.
 */
const RECLAIM_MS = 6 * 60_000;
const BOOT_MS = 60_000;
/** A boot without a snapshot: a base image's first, and a device's when its snapshot doesn't load. */
const COLD_BOOT_MS = 120_000;
/** How long a base image build that failed isn't tried again: every adb call in every ward would wait minutes for the same failure. */
const BASE_RETRY_MS = 5 * 60_000;
/** First-boot work goes on after sys.boot_completed; the snapshot is taken once it has had this long. */
const SETTLE_MS = 10_000;
const SAVE_MS = 45_000;

interface Device {
  readonly ward: string;
  readonly worktree: string;
  readonly serial: string;
  readonly port: number;
  /** The base image it runs from, which is kept while it does. */
  readonly avd: string;
  readonly startedAt: string;
  /** The emulator's pid, 0 until its unit has started. */
  pid: number;
  state: "booting" | "ready";
  /** Being stopped, or its stop failed: no longer anyone's to use, relay or list. */
  stopping?: boolean;
}

const devices = new Map<string, Device>();
/** The last start or stop of each ward's device, which the next one waits for. */
const turns = new Map<string, Promise<unknown>>();
/** Each ward's console port, kept from one device to its next so its serial stays the same. */
const ports = new Map<string, number>();
/** When each device's last use was last written down (see useDevice). */
const noted = new Map<string, number>();

const runDir = (owner: string) => join(DEVICE_DIR, "run", owner);
const info = ({ serial, ward, worktree, state, startedAt }: Device): DeviceInfo => ({ serial, ward, worktree, state, startedAt });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stopUnit = (unit: string) => systemctl("stop", unit).catch(() => undefined);

/** Whether `pid` is still the emulator of `unit`: a pid alone could be another process by now. */
function alive(unit: string, pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().endsWith(`/${unit}`);
  } catch {
    return false;
  }
}

/** The last lines of an emulator's log, for an error message. */
function tail(file: string): string {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-8);
    return lines.length ? `:\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

// ── The base image ───────────────────────────────────────────────────────────

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** A base image's name: what it was built from, hashed, so a change in any of it means another image. */
export const baseName = (sources: readonly string[]) => `ward-base-${createHash("sha256").update(sources.join("\0")).digest("hex").slice(0, 8)}`;

/**
 * The AVD of yours that ward devices take their hardware from: WARD_DEVICE_TEMPLATE,
 * else the one taken before while it exists, else the first by name, which is
 * written down: an AVD you make later doesn't change what ward devices are.
 */
function templateName(): string {
  if (process.env.WARD_DEVICE_TEMPLATE !== undefined) return process.env.WARD_DEVICE_TEMPLATE;
  const file = join(DEVICE_DIR, "template");
  const kept = read(file).trim();
  if (kept !== "" && existsSync(join(USER_AVD_HOME, `${kept}.ini`))) return kept;
  const first = readdirSync(USER_AVD_HOME).filter((e) => e.endsWith(".ini")).sort()[0]?.slice(0, -4);
  if (first === undefined) throw new Error(`no AVD in ${USER_AVD_HOME} to model ward devices on: create one, or name one with WARD_DEVICE_TEMPLATE`);
  mkdirSync(DEVICE_DIR, { recursive: true });
  writeFileSync(file, first);
  return first;
}

/**
 * The base image for what is installed now: its name, and the AVD files it is
 * made of. Of the template AVD only `config.ini` is read; it is never booted or
 * changed. The salt is rewritten when an image's snapshot turns out not to load.
 */
function currentBase(): { readonly name: string; readonly ini: string; readonly config: string } {
  const template = templateName();
  const ini = readFileSync(join(USER_AVD_HOME, `${template}.ini`), "utf8");
  const config = readFileSync(join(/^path=(.+)$/m.exec(ini)?.[1] ?? join(USER_AVD_HOME, `${template}.avd`), "config.ini"), "utf8");
  const image = join(SDK, /^image\.sysdir\.1\s*=\s*(.+)$/m.exec(config)?.[1]?.trim() ?? "");
  if (!existsSync(join(image, "system.img"))) throw new Error(`the AVD ${template} names no installed system image (${image})`);
  const sources = [RECIPE, GPU, read(join(DEVICE_DIR, "salt")), config, read(join(SDK, "emulator/source.properties")), read(join(image, "source.properties")), read(join(image, "build.prop"))];
  const name = baseName(sources);
  // The copy says its own name where the template says the template's.
  return { name, ini: /^target=.+$/m.exec(ini)?.[0] ?? "", config: config.replace(/^(AvdId|avd\.ini\.displayname)\s*=.*$/gm, `$1=${name}`) };
}

const readyMarker = (name: string) => join(AVD_HOME, `${name}.avd`, "ward-ready");
const baseNames = () => (existsSync(AVD_HOME) ? readdirSync(AVD_HOME).filter((e) => /^ward-base-[0-9a-f]+\.avd$/.test(e)).map((e) => e.slice(0, -4)) : []);
const removeBase = (name: string) => {
  rmSync(join(AVD_HOME, `${name}.avd`), { recursive: true, force: true });
  rmSync(join(AVD_HOME, `${name}.ini`), { force: true });
};

let base: Promise<string> | undefined;
let baseFailure: { readonly name: string; readonly error: unknown; readonly at: number } | undefined;
/**
 * The name of a base image that is ready, built first if the current one isn't:
 * one build at a time, shared by everyone waiting. A build that failed fails
 * everyone who asks in the next BASE_RETRY_MS, with the same reason.
 */
function ensureBase(): Promise<string> {
  const current = currentBase();
  if (existsSync(readyMarker(current.name))) return Promise.resolve(current.name);
  if (baseFailure?.name === current.name && Date.now() - baseFailure.at < BASE_RETRY_MS) return Promise.reject(baseFailure.error);
  return (base ??= buildBase(current)
    .catch((error: unknown) => {
      baseFailure = { name: current.name, error, at: Date.now() };
      throw error;
    })
    .finally(() => (base = undefined)));
}

/**
 * Build a base image: a new AVD, booted once writable with no window, and stopped
 * with SIGINT once Android is up, which makes the emulator save the `default_boot`
 * snapshot every device then starts from. No adb server anyone uses ever sees it:
 * it listens outside the range adb servers scan and is told the adb server is on a
 * port of its own, so an install from the host can't land on it (what changed on
 * it would be in every ward's device). Its boot is read from its log instead of
 * asked over adb.
 */
async function buildBase({ name, ini, config }: ReturnType<typeof currentBase>): Promise<string> {
  const dir = join(AVD_HOME, `${name}.avd`);
  const tmp = runDir("base");
  const logFile = join(DEVICE_DIR, "base.log");
  const began = Date.now();
  log(`device: building the base image ${name}`);
  try {
    await stopUnit(BASE_UNIT);
    removeBase(name);
    for (const path of [tmp, logFile]) rmSync(path, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(AVD_HOME, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\n${ini}\n`);
    writeFileSync(join(dir, "config.ini"), config);
    const port = await pickBasePort();
    const pid = await startEmulator(BASE_UNIT, "Ward's base Android image, being built", name, tmp, logFile, ["-ports", `${port},${port + 1}`], {
      ANDROID_ADB_SERVER_PORT: String(port + BASE_ADB_SERVER_OFFSET),
      ...BASE_ADB_ENV,
    });
    await bootLogged(BASE_UNIT, pid, logFile, COLD_BOOT_MS);
    await sleep(SETTLE_MS);
    await systemctl("kill", "--kill-whom=main", "--signal=INT", BASE_UNIT);
    for (const deadline = Date.now() + SAVE_MS; alive(BASE_UNIT, pid); await sleep(200))
      if (Date.now() > deadline) throw new Error(`the emulator did not exit after SIGINT${tail(logFile)}`);
    if (!existsSync(join(dir, "snapshots/default_boot/ram.bin"))) throw new Error(`the emulator saved no boot snapshot${tail(logFile)}`);
    writeFileSync(readyMarker(name), "");
    log(`device: the base image ${name} is ready (${Math.round((Date.now() - began) / 1000)} s)`);
    return name;
  } catch (error) {
    await stopUnit(BASE_UNIT);
    removeBase(name);
    throw new Error(`could not build the base image for ward devices: ${message(error)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const snapshotFailed = (logFile: string) => /Failed to load snapshot/.test(read(logFile));

/**
 * A device booted without its snapshot (the emulator's log says so): it works
 * if it is given the time, but took a cold boot. Change the salt so the next start builds a new base image,
 * at most once a day, in case the new one fares no better.
 */
function distrustBase(avd: string): void {
  const salt = join(DEVICE_DIR, "salt");
  if (existsSync(salt) && Date.now() - statSync(salt).mtimeMs < 86_400_000) return;
  log(`device: the snapshot of ${avd} did not load; the next device start builds a new base image`);
  writeFileSync(salt, new Date().toISOString());
}

// ── Emulators ────────────────────────────────────────────────────────────────

/**
 * Start an emulator as a transient unit and return its pid. It runs under the
 * wards' slice, so devices share the agents' memory limit, and is the first the
 * kernel kills when memory runs out: a device is replaced by a fresh one anyway.
 * `dir` is its TMPDIR: on disk, where a read-only instance keeps its overlays
 * (the default is /tmp, which is memory), and its own, because the emulator
 * finds its radio simulator (netsimd) through the temp folder, so each gets one
 * that stops with its unit rather than sharing the one your emulators use.
 * `flags` says which ports it listens on (`-port`, or `-ports`) and anything else
 * that differs; `env` is added to the emulator's environment.
 */
async function startEmulator(unit: string, description: string, avd: string, dir: string, logFile: string, flags: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<number> {
  mkdirSync(dir, { recursive: true });
  await run("chattr", ["+C", dir]).catch(() => undefined); // overlays are rewritten in place: no copy-on-write, where the filesystem has it
  await run("systemd-run", [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    `--description=${description}`,
    "--slice=app-t3code-agents-wards.slice",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10",
    "--property=OOMScoreAdjust=500",
    `--property=StandardOutput=append:${logFile}`,
    `--property=StandardError=append:${logFile}`,
    `--setenv=ANDROID_AVD_HOME=${AVD_HOME}`,
    `--setenv=ANDROID_HOME=${SDK}`,
    `--setenv=ANDROID_SDK_ROOT=${SDK}`,
    `--setenv=TMPDIR=${dir}`,
    ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
    join(SDK, "emulator/emulator"),
    "-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-gpu", GPU,
    ...flags,
  ]);
  return Number((await systemctl("show", "--property=MainPID", "--value", unit)).stdout.trim());
}

/**
 * Start the host's adb server unless it runs, in a scope of its own: one that an
 * adb command of wardd's started would be part of wardd's unit and stop with
 * every wardd restart, cutting T3 off its devices.
 */
export const startHostAdb = () => run("systemd-run", ["--user", "--scope", "--quiet", "--collect", HOST_ADB, "start-server"], { timeout: 30_000 });

/**
 * Wait until the emulator's log says Android has booted, for a base image build,
 * which has no adb server to ask. Throws, with the end of the log, if the emulator
 * exits first or takes longer than `timeoutMs`.
 */
async function bootLogged(unit: string, pid: number, logFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!/Boot completed in \d+ ms/.test(read(logFile))) {
    if (!alive(unit, pid)) throw new Error(`the emulator exited${tail(logFile)}`);
    if (Date.now() > deadline) throw new Error(`Android did not boot within ${timeoutMs / 1000} s${tail(logFile)}`);
    await sleep(250);
  }
}

/**
 * Wait until Android on `serial` has booted and answers: `sys.boot_completed`
 * alone is already set in a boot snapshot, before anything in it runs again.
 * It must name `avd` as its own, in case the port is another emulator's that
 * took it first. Throws, with the end of its log, if its emulator exits first,
 * takes too long (a snapshot that didn't load gets a cold boot's time), or is
 * no longer `wanted`.
 */
async function booted(serial: string, avd: string, unit: string, pid: number, logFile: string, timeoutMs: number, wanted: () => boolean = () => true): Promise<void> {
  await startHostAdb().catch((error: unknown) => {
    throw new Error(`could not start the host's adb server: ${message(error)}`);
  });
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(unit, pid)) throw new Error(`the emulator exited${tail(logFile)}`);
    if (!wanted()) throw new Error("its ward stopped");
    const up = await run(HOST_ADB, ["-s", serial, "shell", "getprop sys.boot_completed; getprop ro.boot.qemu.avd_name; pm path android"], { timeout: 5000 }).then(
      ({ stdout }) => {
        const [completed, name, android] = stdout.split(/\r?\n/);
        return completed === "1" && name === avd && android?.startsWith("package:") === true;
      },
      () => false,
    );
    if (up) return;
    if (Date.now() > deadline) {
      if (timeoutMs >= COLD_BOOT_MS || !snapshotFailed(logFile)) throw new Error(`Android did not boot within ${timeoutMs / 1000} s${tail(logFile)}`);
      deadline += COLD_BOOT_MS - timeoutMs;
      timeoutMs = COLD_BOOT_MS;
    }
    await sleep(250);
  }
}

const canListen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false)).listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

/**
 * Give `owner` a console port whose adb port (the next one) is free too: its own
 * from before, else one no ward holds, else that of a ward whose device isn't
 * running, which then gets another for its next device.
 */
async function pickPort(owner: string): Promise<number> {
  const held = new Map([...ports].filter(([other]) => other !== owner).map(([other, port]) => [port, other]));
  const own = ports.get(owner);
  const candidates = [
    ...(own === undefined ? [] : [own]),
    ...PORTS.filter((port) => !held.has(port)),
    ...PORTS.filter((port) => held.has(port) && !devices.has(held.get(port)!)),
  ];
  for (const port of candidates) {
    if (!(await canListen(port)) || !(await canListen(port + 1))) continue;
    const holder = held.get(port);
    if (holder !== undefined) ports.delete(holder);
    ports.set(owner, port);
    return port;
  }
  throw new Error(`no emulator port is free between ${PORTS.at(-1)} and ${PORTS[0]}`);
}

/** The first console port of BASE_PORTS whose adb port and announcement port are free too. */
async function pickBasePort(): Promise<number> {
  for (const port of BASE_PORTS)
    if ((await canListen(port)) && (await canListen(port + 1)) && (await canListen(port + BASE_ADB_SERVER_OFFSET))) return port;
  throw new Error(`no emulator port is free among ${BASE_PORTS.join(", ")}`);
}

let queue: Promise<unknown> = Promise.resolve();
/** One at a time: choosing a port and making room look at every device, and wait in between. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => undefined);
  return next;
}

// ── Each ward's device ───────────────────────────────────────────────────────

/** Run `fn` once the last start or stop of ward `id`'s device has settled, so the two never overlap. */
function inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (turns.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
  turns.set(id, next);
  void next.catch(() => undefined).finally(() => turns.get(id) === next && turns.delete(id));
  return next;
}

/** Ward `id`'s device if it has one, booting or up. One whose emulator is gone (it crashed, or T3 shut it down) is cleared away. */
function deviceOf(id: string): Device | undefined {
  const device = devices.get(id);
  if (device === undefined || device.state === "booting" || alive(deviceUnitName(id), device.pid)) return device;
  log(`device: ${device.serial} of ward ${id} is gone (it crashed, was killed for memory, or T3 shut it down); the ward's next use starts a fresh one`);
  forget(id);
  return undefined;
}

function forget(id: string): void {
  devices.delete(id);
  noted.delete(id);
  rmSync(runDir(id), { recursive: true, force: true });
}

/** The console port of ward `id`'s device once it is up; the device's adb port is the next. Not while it boots: the port isn't known to be its own yet. */
export function consolePort(id: string): number | undefined {
  const device = deviceOf(id);
  return device?.state === "ready" && !device.stopping ? device.port : undefined;
}

/**
 * Start ward `id`'s device unless it is up, and count this as a use. Resolves once
 * Android has booted; everyone who asks meanwhile gets the same device. A start
 * gives up once `wanted` says no: the ward it was for stopped.
 */
export async function startDevice(id: string, worktree: string, wanted: () => boolean = () => true): Promise<DeviceInfo> {
  const device = await inTurn(id, async () => {
    const up = deviceOf(id);
    return up?.state === "ready" && !up.stopping ? up : boot(id, worktree, wanted);
  });
  useDevice(id);
  return info(device);
}

async function boot(id: string, worktree: string, wanted: () => boolean): Promise<Device> {
  const unit = deviceUnitName(id);
  // One whose stop failed, or that a wardd left when it died while it booted. While it
  // is still there it keeps its record, for the reconciler to stop.
  const last = devices.get(id);
  await stopUnit(unit);
  if (last !== undefined && alive(unit, last.pid)) throw new Error(`ward ${id}'s last device, ${last.serial}, has not stopped yet`);
  const avd = await ensureBase();
  const dir = runDir(id);
  const logFile = join(dir, "log");
  const stopped = () => new Error(`ward ${id} stopped while its device was starting`);
  const device = await exclusive(async () => {
    if (!wanted()) throw stopped();
    await makeRoom(id);
    const port = await pickPort(id);
    const starting: Device = { ward: id, worktree, serial: `emulator-${port}`, port, avd, startedAt: new Date().toISOString(), pid: 0, state: "booting" };
    devices.set(id, starting);
    return starting;
  });
  try {
    rmSync(dir, { recursive: true, force: true });
    if (!wanted()) throw stopped();
    device.pid = await startEmulator(unit, `Ward device of ${id}`, avd, dir, logFile, ["-port", String(device.port), "-read-only", "-no-snapshot-save"]);
    await booted(device.serial, avd, unit, device.pid, logFile, BOOT_MS, wanted);
    device.state = "ready";
    writeFileSync(join(dir, "device.json"), JSON.stringify(device));
    if (snapshotFailed(logFile)) distrustBase(avd);
    log(`device: started ${device.serial} for ward ${id}`);
    return device;
  } catch (error) {
    if (snapshotFailed(logFile)) distrustBase(avd);
    await stopUnit(unit);
    forget(id);
    throw new Error(`ward ${id}'s device did not start: ${message(error)}`);
  }
}

/**
 * Called before one more device starts. At the limit, the device unused longest
 * gives way if it sat unused for RECLAIM_MS; else this throws. One that is
 * starting or stopping is left alone: its turn may be waiting for this one's.
 */
async function makeRoom(id: string): Promise<void> {
  const others = [...devices.keys()].filter((other) => other !== id).flatMap((other) => deviceOf(other) ?? []);
  if (others.length < MAX) return;
  const now = Date.now();
  const idle = others
    .filter((d) => d.state === "ready" && !turns.has(d.ward) && now - usedAt(d.ward) > RECLAIM_MS)
    .sort((a, b) => usedAt(a.ward) - usedAt(b.ward))[0];
  if (idle === undefined)
    throw new Error(`all ${MAX} ward devices are in use (WARD_DEVICE_MAX); one frees up once it has gone unused for ${RECLAIM_MS / 60_000} minutes`);
  await stopDevice(idle.ward);
  log(`device: stopped ${idle.serial} of ward ${idle.ward}, unused the longest, to make room for ward ${id}`);
}

/**
 * Stop ward `id`'s device, once a start under way has finished; with `when`, only
 * if that still says so by then. Its data goes with it. Whether one was stopped.
 * From the moment it is to stop, the device is nobody's: a ward started again
 * meanwhile gets a new one, also if the emulator is still there afterwards,
 * which throws.
 */
export function stopDevice(id: string, when?: () => boolean): Promise<boolean> {
  const retire = () => {
    const device = devices.get(id);
    if (device?.state !== "ready") return;
    device.stopping = true;
    rmSync(join(runDir(id), "device.json"), { force: true }); // nor a later wardd's to take up (loadDevices)
  };
  if (when === undefined) retire();
  return inTurn(id, async () => {
    const device = deviceOf(id);
    if (when !== undefined && !when()) return false;
    retire();
    const unit = deviceUnitName(id);
    await stopUnit(unit);
    if (device !== undefined && alive(unit, device.pid)) throw new Error(`ward ${id}'s device, ${device.serial}, did not stop`);
    forget(id);
    return device !== undefined;
  });
}

/** Ward `id` stopped: its device stops, and its port is anyone's. */
export async function releaseDevice(id: string): Promise<void> {
  await stopDevice(id);
  ports.delete(id);
}

const usedFile = (id: string) => join(runDir(id), "used");
const usedAt = (id: string) => {
  try {
    return statSync(usedFile(id)).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Ward `id`'s device was used: now, or until `until` (`ward device --keep`), a time
 * the idle stop then counts from. Kept as a file's time, so it outlives a wardd
 * restart, and written at most every few seconds: wardd calls this for every
 * piece of adb traffic from the device.
 */
export function useDevice(id: string, until = Date.now()): void {
  if (!devices.has(id)) return;
  const now = Date.now();
  if (until <= now && now - (noted.get(id) ?? 0) < 5000) return;
  noted.set(id, now);
  const at = Math.max(until, usedAt(id)) / 1000;
  try {
    writeFileSync(usedFile(id), "", { flag: "a" });
    utimesSync(usedFile(id), at, at);
  } catch {
    // Its folder went with the device.
  }
}

/** Every serial Ward owns, for `ward devices`: each ward's device. */
export function listDevices(): DeviceList {
  return { avds: baseNames(), devices: [...devices.keys()].flatMap((id) => deviceOf(id) ?? []).filter((d) => !d.stopping).map(info) };
}

/**
 * Stop the devices of wards that aren't running, and those unused for IDLE_MS;
 * delete base images nothing runs from any more. Returns what it did.
 */
export async function reconcileDevices(wardUp: (id: string) => boolean): Promise<string[]> {
  const actions: string[] = [];
  for (const id of [...devices.keys()]) {
    const device = deviceOf(id);
    if (device?.state !== "ready") continue;
    const why = () => {
      const unused = Date.now() - usedAt(id);
      return device.stopping ? "its last stop did not finish" : !wardUp(id) ? "its ward is not running" : unused > IDLE_MS ? `unused for ${Math.round(unused / 60_000)} minutes` : undefined;
    };
    const reason = why();
    if (reason === undefined) continue;
    try {
      // Asked again in its turn: a use may have been waiting ahead of this.
      if (!(await stopDevice(id, () => devices.get(id) === device && why() !== undefined))) continue;
      if (!wardUp(id)) ports.delete(id);
      actions.push(`stopped ${device.serial}, the device of ${id}: ${reason}`);
    } catch (error) {
      actions.push(message(error));
    }
  }
  try {
    const keep = new Set([currentBase().name, ...[...devices.values()].map((d) => d.avd)]);
    for (const name of baseNames()) {
      if (keep.has(name) || base !== undefined || turns.size > 0) continue; // a start under way may be about to run from it
      removeBase(name);
      actions.push(`deleted the base image ${name}: no device runs from it`);
    }
  } catch {
    // No template to say which base is current: nothing is deleted.
  }
  return actions;
}

/**
 * At wardd's start: take up the devices that are running, and clear away what a
 * wardd that died left half done (a device that was still booting, a base image
 * that was still building).
 */
export async function loadDevices(): Promise<void> {
  await stopUnit(BASE_UNIT);
  for (const name of baseNames()) if (!existsSync(readyMarker(name))) removeBase(name);
  const dir = join(DEVICE_DIR, "run");
  for (const id of existsSync(dir) ? readdirSync(dir) : []) {
    try {
      const device = JSON.parse(readFileSync(join(runDir(id), "device.json"), "utf8")) as Device;
      if (device.ward === id && device.state === "ready" && alive(deviceUnitName(id), device.pid)) {
        devices.set(id, device);
        ports.set(id, device.port);
        continue;
      }
    } catch {
      // No record: it never finished booting.
    }
    await stopUnit(deviceUnitName(id));
    rmSync(runDir(id), { recursive: true, force: true });
  }
}
