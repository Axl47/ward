// Paths and worktree → ward resolution. libexec/ward-lib.sh mirrors these rules
// for the shell hot path; keep the two in sync.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const env = process.env;

export const WARD_HOME = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATE_DIR = join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "ward");
export const CONFIG_DIR = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "ward");
export const RUNTIME_DIR = join(env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`, "ward");
export const T3_HOME = env.T3CODE_HOME ?? join(home, ".t3");
export const WORKTREES_DIR = join(T3_HOME, "worktrees");
export const T3_STATE_DB = join(T3_HOME, "userdata/statev2.sqlite");
export const CONTROL_SOCKET = join(RUNTIME_DIR, "wardd.sock");
export const REGISTRY_FILE = join(STATE_DIR, "registry.json");

/** Host loopback ports forwarded into every ward; never mapped back out. */
export const HOST_PORTS: ReadonlySet<number> = new Set(
  (env.WARD_HOST_PORTS ?? "5037").split(",").map(Number).filter(Number.isInteger),
);

export interface WardLocation {
  readonly id: string;
  readonly repo: string;
  /** The worktree's root folder: <worktrees>/<repo>/<name>. */
  readonly root: string;
}

const sanitize = (segment: string) => segment.replace(/[^A-Za-z0-9_-]/g, "_");

/** The ward for a folder inside a T3 worktree, or undefined for any other folder. */
export function locate(dir: string): WardLocation | undefined {
  const abs = resolve(dir);
  if (!abs.startsWith(WORKTREES_DIR + sep)) return undefined;
  const [repo, name] = abs.slice(WORKTREES_DIR.length + 1).split(sep);
  if (!repo || !name) return undefined;
  return { id: `${sanitize(repo)}.${sanitize(name)}`, repo, root: join(WORKTREES_DIR, repo, name) };
}

export const isEnabled = (repo: string) => existsSync(join(CONFIG_DIR, "enabled", repo));
export const enabledMarker = (repo: string) => join(CONFIG_DIR, "enabled", basename(repo));

export const wardRuntimeDir = (id: string) => join(RUNTIME_DIR, id);
export const wardStateDir = (id: string) => join(STATE_DIR, "wards", id);
export const unitName = (id: string) => `ward@${id}.service`;
