// Paths and worktree → ward resolution. libexec/ward-lib.sh mirrors these rules
// for the shell hot path; keep the two in sync.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const env = process.env;

export const WARD_HOME = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATE_DIR = join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "ward");
export const CONFIG_DIR = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "ward");
export const RUNTIME_DIR = join(env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`, "ward");
/** The T3 home Ward serves. Not T3CODE_HOME: dev servers point that at their own state. */
export const T3_HOME = env.WARD_T3_HOME ?? join(home, ".t3");
/** Where T3 puts worktrees when its `worktreesDirectory` setting is unset. */
export const DEFAULT_WORKTREES_DIR = join(T3_HOME, "worktrees");
const T3_SETTINGS = join(T3_HOME, "userdata/settings.json");
export const CONTROL_SOCKET = join(RUNTIME_DIR, "wardd.sock");
/**
 * Where `ward exec` leaves a record of each agent command while a recorder (Miranda) asks for
 * them (bin/ward: ward_recording). wardd creates it; every ward sees an empty folder in its place.
 */
export const ACTIVITY_DIR = join(RUNTIME_DIR, "activity");
export const REGISTRY_FILE = join(STATE_DIR, "registry.json");

/** Plain decimal TCP ports in a comma-separated list; anything else (hex, exponents, signs) is dropped. */
export const parsePorts = (text: string) =>
  text.split(",").map((p) => p.trim()).filter((p) => /^\d{1,5}$/.test(p)).map(Number).filter((p) => p > 0 && p < 65536);

/** Host loopback ports forwarded into every ward (T3, adb); DNS (53) always is too. */
export const HOST_PORTS: readonly number[] = parsePorts(env.WARD_HOST_PORTS ?? "3773,5037");

export interface WardLocation {
  readonly id: string;
  readonly repo: string;
  /** The worktree's root folder: <worktrees>/<repo>/<name>. */
  readonly root: string;
}

/** Byte-wise, like ward-lib.sh's `tr`, so both sides agree on non-ASCII names. */
const sanitize = (segment: string) =>
  [...Buffer.from(segment, "utf8")].map((b) => (/[A-Za-z0-9_-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "_")).join("");

/**
 * The folders T3 puts worktrees in: the default one, which keeps the worktrees
 * made before the setting changed, and T3's `worktreesDirectory` setting when it
 * is an absolute path. Read on every call, so a change applies without restarting.
 */
export function worktreeRoots(): string[] {
  try {
    const { worktreesDirectory } = JSON.parse(readFileSync(T3_SETTINGS, "utf8")) as { worktreesDirectory?: unknown };
    if (typeof worktreesDirectory === "string" && worktreesDirectory.startsWith("/"))
      return [...new Set([DEFAULT_WORKTREES_DIR, resolve(worktreesDirectory)])];
  } catch {
    // No settings file, or one T3 is mid-write: the default folder still counts.
  }
  return [DEFAULT_WORKTREES_DIR];
}

/** The ward for a folder inside a T3 worktree (<root>/<repo>/<name>/...), or undefined for any other folder. */
export function locate(dir: string): WardLocation | undefined {
  const abs = resolve(dir);
  for (const root of worktreeRoots()) {
    if (!abs.startsWith(root + sep)) continue;
    const [repo, name] = abs.slice(root.length + 1).split(sep);
    if (!repo || !name) return undefined;
    return { id: `${sanitize(repo)}.${sanitize(name)}`, repo, root: join(root, repo, name) };
  }
  return undefined;
}

/** A project's opt-in marker. Its content lists more host ports for that project's wards, e.g. "39003". */
export const enabledMarker = (repo: string) => join(CONFIG_DIR, "enabled", basename(repo));
export const isEnabled = (repo: string) => existsSync(enabledMarker(repo));

/** Host ports a project's wards reach on top of HOST_PORTS, from its marker. */
export function projectHostPorts(repo: string): number[] {
  try {
    return parsePorts(readFileSync(enabledMarker(repo), "utf8"));
  } catch {
    return [];
  }
}

/** Your Gradle home, as wardd runs: each ward gets its own mounted over it (src/gradle.ts). */
export const GRADLE_SOURCE_HOME = env.GRADLE_USER_HOME ?? join(home, ".gradle");
/** Where Kotlin daemons leave their run files; each ward gets its own folder mounted over it. */
export const KOTLIN_DAEMON_DIR = join(env.XDG_DATA_HOME || join(home, ".local/share"), "kotlin/daemon");
/** The build cache wardd serves to wards: one folder per project, of entries named by key. */
export const BUILD_CACHE_DIR = join(STATE_DIR, "build-cache");

export const wardRuntimeDir = (id: string) => join(RUNTIME_DIR, id);
/** The ward desktop's own XDG_RUNTIME_DIR: its Wayland, Umbriel and session bus sockets, and `env` once it is up. */
export const wardDesktopDir = (id: string) => join(RUNTIME_DIR, id, "desktop");
export const wardStateDir = (id: string) => join(STATE_DIR, "wards", id);
/** Where a removed ward's data waits before it is purged, keyed by worktree so colliding ids can't clash. */
export const wardTrashDir = (id: string, worktree: string) =>
  join(STATE_DIR, "trash", `${id}.${createHash("sha256").update(worktree).digest("hex").slice(0, 8)}`);
/**
 * The id of the desktop of a T3 thread that has no ward. It has no dot, which
 * every ward's id has, so the two never share a runtime folder.
 */
export const threadDesktopId = (thread: string) => `t-${sanitize(thread)}`;
/** A thread desktop's caches, app profiles and log, kept only while it runs. */
export const desktopStateDir = (id: string) => join(STATE_DIR, "desktops", id);
/** One note per T3 thread of a warded worktree (bin/ward: ward_thread_note): the worktree, then the thread's id. */
export const THREAD_WARDS_DIR = join(STATE_DIR, "thread-wards");
/** The transient unit a thread's desktop runs as. */
export const desktopUnitName = (id: string) => `${env.WARD_UNIT ?? "ward"}-desktop-${id}.service`;
/** Unit template wards run under; WARD_UNIT names another, to run a second Ward beside the installed one. */
export const unitName = (id: string) => `${env.WARD_UNIT ?? "ward"}@${id}.service`;
