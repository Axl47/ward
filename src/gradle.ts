// Gradle in wards: each ward's own Gradle home, cloned from yours, and the HTTP
// build cache wardd serves to a project's wards (docs/DESIGN.md: Caches). Wards
// share no Gradle files, so no ward waits on another's locks or stops its daemon.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BUILD_CACHE_DIR, GRADLE_SOURCE_HOME } from "./paths.ts";

const run = promisify(execFile);

/** The port the build cache has on every ward's loopback, where its broker hands connections to wardd. */
export const BUILD_CACHE_PORT = 5071;

const INIT_SCRIPT = `// Written by Ward on every \`ward up\`. Points the build cache at the one wardd
// serves to this project's wards; whether a build uses it is org.gradle.caching's choice.
gradle.settingsEvaluated { settings ->
    settings.buildCache {
        local { enabled = false }
        remote(HttpBuildCache) {
            url = 'http://127.0.0.1:${BUILD_CACHE_PORT}/cache/'
            push = true
            allowInsecureProtocol = true
        }
    }
}
`;
const INIT_SCRIPT_NAME = "ward-build-cache.gradle";
const IDLE_TIMEOUT_KEY = /^[ \t]*org\.gradle\.daemon\.idletimeout(?=[ \t=:])/m;

const children = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Give a ward its own Gradle home, unless it has one: a reflink clone of the source
 * home's dependency caches, Gradle-version caches and wrapper, without the files
 * Gradle regenerates (locks, journals, daemons, the local build cache). Called by
 * `up` before the ward starts. On failure the ward gets an empty home.
 */
export async function cloneGradleHome(home: string, source = GRADLE_SOURCE_HOME): Promise<string | undefined> {
  if (existsSync(home)) return;
  const tmp = `${home}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "caches"), { recursive: true });
  const caches = children(join(source, "caches"))
    .filter((name) => name === "modules-2" || name.startsWith("jars-") || /^\d+\.\d+/.test(name))
    .map((name) => join(source, "caches", name));
  try {
    if (caches.length > 0) await run("cp", ["-a", "--reflink=auto", "--", ...caches, join(tmp, "caches")]);
    if (existsSync(join(source, "wrapper"))) await run("cp", ["-a", "--reflink=auto", "--", join(source, "wrapper"), tmp]);
    await run("find", [tmp, "-depth", "(", "-name", "*.lock", "-o", "-name", "gc.properties", "-o", "-name", ".tmp", ")", "-exec", "rm", "-rf", "--", "{}", "+"]);
    renameSync(tmp, home);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    return `could not clone ${source}, so its Gradle home starts empty: ${String(error)}`;
  }
}

/**
 * Bring a ward's Gradle home's settings in line with the source home's: its
 * gradle.properties, plus a 10-minute daemon idle timeout unless that file sets
 * one, and its init scripts, plus Ward's build cache script. Called on every `up`,
 * so a change to yours reaches running wards.
 */
export function writeGradleSettings(home: string, source = GRADLE_SOURCE_HOME): void {
  let properties = "";
  try {
    properties = readFileSync(join(source, "gradle.properties"), "utf8");
  } catch {}
  if (!IDLE_TIMEOUT_KEY.test(properties))
    properties += `${properties === "" || properties.endsWith("\n") ? "" : "\n"}# Added by Ward: idle daemons in a ward stop after 10 minutes.\norg.gradle.daemon.idletimeout=600000\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gradle.properties.tmp"), properties);
  renameSync(join(home, "gradle.properties.tmp"), join(home, "gradle.properties"));

  const initD = join(home, "init.d");
  mkdirSync(initD, { recursive: true });
  const yours = children(join(source, "init.d")).filter((name) => name !== INIT_SCRIPT_NAME);
  for (const name of yours) copyFileSync(join(source, "init.d", name), join(initD, name));
  writeFileSync(join(initD, INIT_SCRIPT_NAME), INIT_SCRIPT);
  for (const name of children(initD)) if (name !== INIT_SCRIPT_NAME && !yours.includes(name)) rmSync(join(initD, name), { recursive: true, force: true });
}

const isKey = (name: string) => /^[0-9a-f]{32,}$/.test(name);

/** A project's folder in the build cache store. */
export const projectStore = (repo: string, dir = BUILD_CACHE_DIR) => join(dir, repo);

/**
 * Make a project's store. The first time, seed it from the source home's local
 * build cache by reflink, so wards start with what host builds cached; where the
 * file system can't reflink, it starts empty.
 */
export async function ensureProjectStore(store: string, source = GRADLE_SOURCE_HOME): Promise<void> {
  mkdirSync(join(store, ".."), { recursive: true });
  try {
    mkdirSync(store);
  } catch {
    return; // made before
  }
  const local = join(source, "caches/build-cache-1");
  const entries = children(local).filter(isKey).map((name) => join(local, name));
  try {
    for (let i = 0; i < entries.length; i += 500)
      await run("cp", ["--reflink=always", "--preserve=timestamps", "-t", store, "--", ...entries.slice(i, i + 500)]);
  } catch {}
}

const projectStores = new WeakMap<Socket, string>();
const cacheServer = createServer((req, res) => void serve(projectStores.get(req.socket), req, res));

/** Serve the build cache on a connection a ward's broker accepted on BUILD_CACHE_PORT, from that ward's project's store. */
export function acceptBuildCache(socket: Socket, store: string): void {
  projectStores.set(socket, store);
  cacheServer.emit("connection", socket);
  socket.resume(); // the broker hands sockets over paused
}

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Gradle's HTTP build cache protocol: GET /cache/<key> answers the entry or 404,
 * PUT stores it. An entry appears whole or not at all (written aside, then
 * renamed), and a GET marks it recently used for the sweep.
 */
export async function serve(store: string | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const status = (code: number) => void res.writeHead(code).end();
  const key = /^\/cache\/([^/]+)$/.exec(req.url ?? "")?.[1];
  if (store === undefined || key === undefined || !isKey(key)) return status(400);
  const file = join(store, key);
  try {
    if (req.method === "GET") {
      const handle = await open(file);
      const now = new Date();
      await handle.utimes(now, now);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": (await handle.stat()).size });
      await pipeline(handle.createReadStream(), res);
    } else if (req.method === "PUT") {
      await mkdir(store, { recursive: true });
      const tmp = join(store, `.tmp-${randomBytes(8).toString("hex")}`);
      try {
        await pipeline(req, createWriteStream(tmp));
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
      status(200);
    } else {
      status(405);
    }
  } catch (error) {
    if (res.headersSent) res.destroy();
    else status(isMissing(error) ? 404 : 500);
  }
}

/** WARD_BUILD_CACHE_MAX: bytes, or with a K, M or G suffix (powers of 1024); 10 GB when unset or unreadable. */
export function parseSize(text: string | undefined): number {
  const match = /^(\d+)([KMG]?)$/i.exec(text?.trim() ?? "");
  if (match === null) return 10 * 1024 ** 3;
  return Number(match[1]) * 1024 ** "_KMG".indexOf(match[2]?.toUpperCase() || "_");
}

export const BUILD_CACHE_MAX = parseSize(process.env.WARD_BUILD_CACHE_MAX);

/**
 * Delete the least recently used entries across every project until the store
 * is under max bytes, and uploads abandoned over an hour ago. wardd runs it at
 * start and hourly. Resolves to the number of files deleted.
 */
export async function sweepBuildCache(dir = BUILD_CACHE_DIR, max = BUILD_CACHE_MAX, now = Date.now()): Promise<number> {
  const entries: { path: string; size: number; used: number }[] = [];
  let deleted = 0;
  const gone = () => void deleted++;
  for (const project of await readdir(dir).catch(() => [])) {
    const names = await readdir(join(dir, project)).catch(() => []);
    await Promise.all(names.map(async (name) => {
      const path = join(dir, project, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) return;
      if (!name.startsWith(".tmp-")) return void entries.push({ path, size: info.size, used: info.mtimeMs });
      if (info.mtimeMs < now - 3_600_000) await unlink(path).then(gone, () => {});
    }));
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (total <= max) break;
    await unlink(entry.path).then(gone, () => {});
    total -= entry.size;
  }
  return deleted;
}
