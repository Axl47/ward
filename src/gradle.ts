// Gradle in wards: each ward's own Gradle home (cloned from yours when the ward has
// a Gradle build) and Kotlin daemon folder, your settings over the home read-only,
// and the HTTP build cache wardd serves to a project's wards (docs/DESIGN.md: Caches).
// Wards share no Gradle files, so no ward waits on another's locks or stops its daemon.
//
// A ward owns its state folder, so wardd only creates or deletes there while the
// ward's unit is stopped, and never follows a link it finds there. What it rewrites
// while a ward runs (the settings) lives in the ward's runtime folder, which wards
// can't write.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BUILD_CACHE_DIR } from "./paths.ts";

const run = promisify(execFile);

/** The port the build cache has on every ward's loopback, where its broker hands connections to wardd. */
export const BUILD_CACHE_PORT = 5071;

const INIT_SCRIPT = `// Written by Ward. Points the build cache at the one wardd serves to this
// project's wards, unless the project has a remote cache of its own; whether a
// build uses it is org.gradle.caching's choice.
gradle.settingsEvaluated { settings ->
    if (settings.buildCache.remote == null) {
        settings.buildCache {
            local { enabled = false }
            remote(HttpBuildCache) {
                url = 'http://127.0.0.1:${BUILD_CACHE_PORT}/cache/'
                push = true
                allowInsecureProtocol = true
            }
        }
    }
}
`;
const INIT_SCRIPT_NAME = "ward-build-cache.gradle";
const IDLE_TIMEOUT_KEY = /^[ \t]*org\.gradle\.daemon\.idletimeout(?=[ \t=:])/m;

const children = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** A folder of yours a ward's own folder goes over: made if missing, as its real path, which ward-init-root pins. */
export function realFolder(path: string): string {
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

/** Whether a worktree has a Gradle build at its root or one folder down (React Native keeps it in android/). */
export function hasGradleBuild(worktree: string): boolean {
  const top = children(worktree);
  return [top, ...top.filter((e) => e.isDirectory()).map((e) => children(join(worktree, e.name)))].some((entries) =>
    entries.some((e) => e.name === "gradlew" || e.name === "settings.gradle" || e.name === "settings.gradle.kts"),
  );
}

/** Get what a ward left at `path` out of the way: deleted, or moved aside when it can't be (a folder the ward made unreadable). */
function clear(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    renameSync(path, `${path}.left-${Date.now()}`);
  }
}

/**
 * Make `path`, in a ward's state folder, a real folder of the ward's own. Anything
 * else there (a link the ward left, a file) is removed without being followed, and
 * the new folder is a clone of `source` when one is given: a reflink copy of its
 * dependency, transform and Gradle-version caches and wrapper, with the lock files
 * but without gc.properties. Called by `up` only while the ward's unit is stopped.
 * Resolves to why the clone failed, in which case the folder starts empty.
 */
export async function ownFolder(path: string, source?: string): Promise<string | undefined> {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  clear(path);
  mkdirSync(dirname(path), { recursive: true });
  if (source === undefined) return void mkdirSync(path);
  const tmp = `${path}.tmp`;
  clear(tmp);
  try {
    mkdirSync(join(tmp, "caches"), { recursive: true });
    const caches = children(join(source, "caches"))
      .filter(({ name }) => name === "modules-2" || name.startsWith("jars-") || name.startsWith("transforms-") || /^\d+\.\d+/.test(name))
      .map(({ name }) => join(source, "caches", name));
    if (caches.length > 0) await run("cp", ["-a", "--reflink=always", "--", ...caches, join(tmp, "caches")]);
    if (existsSync(join(source, "wrapper"))) await run("cp", ["-a", "--reflink=always", "--", join(source, "wrapper"), tmp]);
    await run("find", [tmp, "-name", "gc.properties", "-delete"]);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path);
    return `could not clone ${source} (${String(error).split("\n")[0]}), so its Gradle home starts empty`;
  }
}

/**
 * Write the settings ward-init-root mounts read-only over a ward's Gradle home, into
 * `dir` in the ward's runtime folder: your gradle.properties, plus a 10-minute daemon
 * idle timeout unless it sets one, and init.d with your regular *.gradle and
 * *.gradle.kts files plus Ward's build cache script. Called on every `up`, and a
 * running ward's mounts show the new ones: gradle.properties is rewritten in place
 * (its mount is of the file) and only when it changed; a script is replaced whole.
 */
export function writeGradleSettings(dir: string, source: string): void {
  let properties = "";
  try {
    properties = readFileSync(join(source, "gradle.properties"), "utf8");
  } catch {}
  if (!IDLE_TIMEOUT_KEY.test(properties))
    properties += `${properties === "" || properties.endsWith("\n") ? "" : "\n"}# Added by Ward: idle daemons in a ward stop after 10 minutes.\norg.gradle.daemon.idletimeout=600000\n`;
  const initD = join(dir, "init.d");
  mkdirSync(initD, { recursive: true });
  const current = join(dir, "gradle.properties");
  if (!existsSync(current) || readFileSync(current, "utf8") !== properties) writeFileSync(current, properties);
  const put = (name: string, text: string | Buffer) => {
    writeFileSync(join(initD, `.${name}.tmp`), text);
    renameSync(join(initD, `.${name}.tmp`), join(initD, name));
  };
  const yours = children(join(source, "init.d"))
    .filter((e) => e.isFile() && /\.gradle(\.kts)?$/.test(e.name) && e.name !== INIT_SCRIPT_NAME)
    .map((e) => e.name);
  for (const name of yours) put(name, readFileSync(join(source, "init.d", name)));
  put(INIT_SCRIPT_NAME, INIT_SCRIPT);
  for (const { name } of children(initD)) if (name !== INIT_SCRIPT_NAME && !yours.includes(name)) rmSync(join(initD, name), { recursive: true, force: true });
}

const isKey = (name: string) => /^[0-9a-f]{32,128}$/.test(name);

/** A project's folder in the build cache store. */
export const projectStore = (repo: string, dir = BUILD_CACHE_DIR) => join(dir, repo);

const projectStores = new WeakMap<Socket, string>();
const cacheServer = createServer((req, res) => void serve(projectStores.get(req.socket), req, res));
// What listen() would otherwise arm: stalled connections are dropped, and Gradle's
// pooled ones are kept between requests.
cacheServer.timeout = 300_000;
cacheServer.keepAliveTimeout = 120_000;

/** Connections one ward may hold to the cache; Gradle keeps a handful. wardd's file descriptors are every ward's. */
const WARD_CONNECTIONS_MAX = 64;
const openConnections = new Map<string, number>();

/**
 * Serve the build cache on a connection ward `id`'s broker accepted on BUILD_CACHE_PORT,
 * from its project's store. Past WARD_CONNECTIONS_MAX the connection is closed.
 */
export function acceptBuildCache(socket: Socket, store: string, id: string): void {
  const open = openConnections.get(id) ?? 0;
  if (open >= WARD_CONNECTIONS_MAX) return void socket.destroy();
  openConnections.set(id, open + 1);
  socket.once("close", () => {
    const left = (openConnections.get(id) ?? 1) - 1;
    if (left > 0) openConnections.set(id, left);
    else openConnections.delete(id);
  });
  projectStores.set(socket, store);
  cacheServer.emit("connection", socket);
  socket.resume(); // the broker hands sockets over paused
}

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** The largest entry the cache takes. */
export const ENTRY_MAX = 1024 ** 3;

/**
 * Gradle's HTTP build cache protocol: GET /cache/<key> answers the entry or 404,
 * PUT stores it. An entry appears whole or not at all (written aside, then
 * renamed), and a GET marks it recently used for the sweep. An empty upload gets
 * 400, one over `max` bytes 413, and neither leaves a file.
 */
export async function serve(store: string | undefined, req: IncomingMessage, res: ServerResponse, max = ENTRY_MAX): Promise<void> {
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
      if (Number(req.headers["content-length"]) > max) return status(413);
      await mkdir(store, { recursive: true });
      const tmp = join(store, `.tmp-${randomBytes(8).toString("hex")}`);
      let size = 0;
      try {
        // Past max, the rest is read and dropped, so the client still gets its 413.
        await pipeline(req, async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) if ((size += chunk.length) <= max) yield chunk;
        }, createWriteStream(tmp));
        if (size === 0 || size > max) {
          await rm(tmp);
          return status(size === 0 ? 400 : 413);
        }
        renameSync(tmp, file); // synchronous, as the sweep's check and delete are: neither lands inside the other
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
      status(200);
      storedSinceSweep += size;
      if (storedSinceSweep > BUILD_CACHE_MAX / 10) sweepSoon();
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
 * is under max bytes, and uploads abandoned over an hour ago. An entry used or
 * replaced since the listing is kept. Resolves to the number of files deleted.
 */
export async function sweepBuildCache(dir = BUILD_CACHE_DIR, max = BUILD_CACHE_MAX, now = Date.now()): Promise<number> {
  const entries: { path: string; size: number; used: number }[] = [];
  let deleted = 0;
  const remove = (path: string) =>
    unlink(path).then(() => {
      deleted++;
      return true;
    }, () => false);
  for (const project of await readdir(dir).catch(() => [])) {
    const names = await readdir(join(dir, project)).catch(() => []);
    await Promise.all(names.map(async (name) => {
      const path = join(dir, project, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) return;
      if (!name.startsWith(".tmp-")) return void entries.push({ path, size: info.size, used: info.mtimeMs });
      if (info.mtimeMs < now - 3_600_000) await remove(path);
    }));
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (total <= max) break;
    try {
      if (statSync(entry.path).mtimeMs !== entry.used) continue;
      unlinkSync(entry.path);
    } catch {
      continue;
    }
    deleted++;
    total -= entry.size;
  }
  return deleted;
}

let sweeping = false;
let storedSinceSweep = 0;

/**
 * Sweep the store unless a sweep is running, and log what it deleted. wardd calls
 * it at start and hourly, and serve once uploads since the last sweep pass a
 * tenth of the cap.
 */
export function sweepSoon(): void {
  if (sweeping) return;
  sweeping = true;
  storedSinceSweep = 0;
  void sweepBuildCache()
    .then((n) => n > 0 && console.log(`build cache: deleted ${n} files`), (e: unknown) => console.log(`build cache sweep: ${String(e)}`))
    .finally(() => {
      sweeping = false;
      if (storedSinceSweep > BUILD_CACHE_MAX / 10) sweepSoon(); // uploads that came in meanwhile
    });
}
