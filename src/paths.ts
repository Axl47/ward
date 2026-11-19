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
export const WORKTREES_DIR = join(T3_HOME, "worktrees");
export const CONTROL_SOCKET = join(RUNTIME_DIR, "wardd.sock");
export const REGISTRY_FILE = join(STATE_DIR, "registry.json");

/** Valid TCP ports in a comma-separated list; anything else is dropped. */
export const parsePorts = (text: string) =>
  text.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

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

/** The ward for a folder inside a T3 worktree, or undefined for any other folder. */
export function locate(dir: string): WardLocation | undefined {
  const abs = resolve(dir);
  if (!abs.startsWith(WORKTREES_DIR + sep)) return undefined;
  const [repo, name] = abs.slice(WORKTREES_DIR.length + 1).split(sep);
  if (!repo || !name) return undefined;
  return { id: `${sanitize(repo)}.${sanitize(name)}`, repo, root: join(WORKTREES_DIR, repo, name) };
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

export const wardRuntimeDir = (id: string) => join(RUNTIME_DIR, id);
export const wardStateDir = (id: string) => join(STATE_DIR, "wards", id);
/** Where a removed ward's data waits before it is purged, keyed by worktree so colliding ids can't clash. */
export const wardTrashDir = (id: string, worktree: string) =>
  join(STATE_DIR, "trash", `${id}.${createHash("sha256").update(worktree).digest("hex").slice(0, 8)}`);
/** Unit template wards run under; WARD_UNIT names another, to run a second Ward beside the installed one. */
export const unitName = (id: string) => `${env.WARD_UNIT ?? "ward"}@${id}.service`;
