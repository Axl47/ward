// wardd: the user daemon behind every ward. It starts and stops ward units,
// maps each port a ward listens on to a host port in the ward's slot, and runs
// the reconciler that stops or removes wards when T3 is done with them.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PortInfo, Route, Routes, UpResult, WardInfo } from "./api.ts";
import type { BrokerReply, BrokerRequest } from "./broker.ts";
import {
  CONTROL_SOCKET,
  HOST_PORTS,
  isEnabled,
  locate,
  unitName,
  WARD_HOME,
  wardRuntimeDir,
  wardStateDir,
} from "./paths.ts";
import { listeningPorts } from "./procnet.ts";
import { freeSlot, loadRegistry, saveRegistry, slotPorts, type WardRecord } from "./registry.ts";
import { threadsByWorktree, type ThreadState } from "./t3state.ts";

const run = promisify(execFile);
const { uid, gid } = userInfo();
const RECONCILE_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

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
  /** Ports the ward's running containers publish, refreshed every other scan. */
  containerPorts: ReadonlySet<number>;
  scanCount: number;
  nextReq: number;
}

const wards = loadRegistry();
const live = new Map<string, LiveWard>();
const locks = new Map<string, Promise<unknown>>();
/** Threads by worktree from the last reconcile, for attributing wards to threads. */
let lastThreads: Map<string, ThreadState[]> | undefined;
/** When wardd last saw each ward start (ISO time), for the reconciler. */
const startedAtById = new Map<string, string>();
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

function writeEnvFile(record: WardRecord): void {
  const rt = wardRuntimeDir(record.id);
  const podman = `unix://${rt}/podman/podman.sock`;
  const vars: Record<string, string> = {
    WARD_ID: record.id,
    WARD_ROOT: record.worktree,
    DOCKER_HOST: podman,
    CONTAINER_HOST: podman,
    TMPDIR: join(wardStateDir(record.id), "tmp"),
  };
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  lines.push(`PATH=${shellQuote(join(WARD_HOME, "shims"))}:"$PATH"`);
  mkdirSync(rt, { recursive: true });
  writeFileSync(join(rt, "env"), lines.join("\n") + "\n");
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
    if (record === undefined) {
      record = { id: location.id, repo: location.repo, worktree: location.root, slot: freeSlot(wards), ports: {}, createdAt: new Date().toISOString() };
      wards.set(record.id, record);
      saveRegistry(wards);
      log(`created ward ${record.id} in slot ${record.slot}`);
    }
    writeEnvFile(record);
    if (!isReady(record.id)) {
      startedAtById.set(record.id, new Date().toISOString());
      await systemctl("start", unitName(record.id));
      await waitReady(record.id);
      log(`started ward ${record.id}`);
    }
    if (!live.has(record.id)) attach(record);
    if (!lastThreads?.has(record.worktree)) void runReconcile(); // learn which threads use it
    return { enabled: true, ward: info(record) };
  });
}

async function waitReady(id: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isReady(id)) return;
    const state = await systemctl("is-active", unitName(id)).then((r) => r.stdout.trim(), (e: { stdout?: string }) => e.stdout?.trim() ?? "unknown");
    if (state === "failed" || state === "inactive")
      throw new Error(`ward ${id} failed to start; see \`journalctl --user -u ${unitName(id)}\``);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`ward ${id} did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}

function stop(id: string): Promise<boolean> {
  return serialized(id, async () => {
    const wasRunning = isReady(id) || live.has(id);
    await systemctl("stop", unitName(id)).catch(() => undefined);
    detach(id);
    if (wasRunning) log(`stopped ward ${id}`);
    return wasRunning;
  });
}

function rm(id: string): Promise<boolean> {
  return serialized(id, async () => {
    await systemctl("stop", unitName(id)).catch(() => undefined);
    detach(id);
    await run(join(WARD_HOME, "libexec/ward-purge"), [id]);
    const existed = wards.delete(id);
    saveRegistry(wards);
    if (existed) log(`removed ward ${id}`);
    return existed;
  });
}

// ── Port mapping ─────────────────────────────────────────────────────────────

function attach(record: WardRecord): void {
  const pid = readPid(record.id);
  if (pid === undefined) return;
  const broker = spawn(
    "nsenter",
    ["-U", "-n", "-t", String(pid), "--setuid", String(uid), "--setgid", String(gid), "--",
      process.execPath, "--disable-warning=ExperimentalWarning", join(WARD_HOME, "src/broker.ts")],
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
    scanCount: 0,
    nextReq: 1,
  };
  live.set(record.id, ward);
  broker.on("message", (reply: BrokerReply, socket: unknown) => {
    if (reply.t === "ready") {
      ward.scanTimer ??= setInterval(() => scan(record.id), 1000);
      // Re-open listeners for ports mapped in an earlier run.
      for (const wardPort of Object.keys(record.ports)) void ensureListener(record.id, Number(wardPort)).catch(() => undefined);
      return scan(record.id);
    }
    const callback = ward.pending.get(reply.req);
    ward.pending.delete(reply.req);
    callback?.(reply, socket instanceof Object && "pipe" in socket ? (socket as Socket) : undefined);
  });
  broker.on("exit", () => {
    if (live.get(record.id) === ward) detach(record.id);
  });
}

function detach(id: string): void {
  const ward = live.get(id);
  if (ward === undefined) return;
  live.delete(id);
  clearInterval(ward.scanTimer);
  for (const server of ward.listeners.values()) server.close();
  for (const callback of ward.pending.values()) callback({ t: "failed", req: 0, message: "ward stopped" }, undefined);
  ward.broker.kill();
}

/**
 * Find the ward's ports: TCP sockets listening on its loopback or wildcard
 * addresses (from the broker's view of /proc/net), plus ports its containers
 * publish (Podman forwards those with firewall rules, not listening sockets).
 */
function scan(id: string): void {
  const ward = live.get(id);
  if (ward === undefined) return;
  const found = new Map<number, string[]>();
  for (const file of ["tcp", "tcp6"] as const) {
    let text: string;
    try {
      text = readFileSync(`/proc/${ward.brokerPid}/net/${file}`, "utf8");
    } catch {
      return; // broker gone; its exit handler detaches the ward
    }
    for (const [port, hosts] of listeningPorts(text)) {
      if (!HOST_PORTS.has(port)) found.set(port, [...new Set([...(found.get(port) ?? []), ...hosts])]);
    }
  }
  for (const port of ward.containerPorts) if (!found.has(port)) found.set(port, ["127.0.0.1"]);
  ward.listening.clear();
  for (const [port, hosts] of found) {
    ward.listening.set(port, hosts);
    if (!ward.listeners.has(port)) void ensureListener(id, port).catch((e: unknown) => log(`ward ${id}: port ${port}: ${String(e)}`));
  }
  if (ward.scanCount++ % 2 === 0) void refreshContainerPorts(id, ward);
}

interface PodmanContainer {
  readonly Ports?: ReadonlyArray<{ readonly IP?: string; readonly PublicPort?: number; readonly Type?: string }> | null;
}

/** Ask the ward's Podman which TCP ports its running containers publish on loopback or all addresses. */
function refreshContainerPorts(id: string, ward: LiveWard): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { socketPath: join(wardRuntimeDir(id), "podman/podman.sock"), path: "/v4.0.0/containers/json", timeout: 2000 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            const containers = JSON.parse(data) as PodmanContainer[];
            ward.containerPorts = new Set(
              containers.flatMap((c) =>
                (c.Ports ?? [])
                  .filter((p) => p.Type === "tcp" && p.PublicPort !== undefined && ["", "0.0.0.0", "127.0.0.1", "::"].includes(p.IP ?? ""))
                  .map((p) => p.PublicPort!),
              ),
            );
          } catch {}
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => req.destroy());
    req.end();
  });
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
    const server = createServer({ pauseOnConnect: true }, (socket) => forward(id, wardPort, socket));
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(hostPort, "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    if (live.get(id) !== ward || ward.listeners.has(wardPort)) {
      server.close(); // lost a race with detach or another ensureListener
      return ward.listeners.has(wardPort) ? record.ports[String(wardPort)]! : hostPort;
    }
    ward.listeners.set(wardPort, server);
    if (known !== hostPort) {
      wards.set(id, { ...record, ports: { ...record.ports, [String(wardPort)]: hostPort } });
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
  const { [String(stale)]: _released, ...ports } = record.ports;
  wards.set(id, { ...record, ports });
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
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.resume();
  });
  const message: BrokerRequest = { t: "connect", req, port: wardPort, hosts: ward.listening.get(wardPort) ?? ["127.0.0.1", "::1"] };
  ward.broker.send(message);
}

// ── Reconciler ───────────────────────────────────────────────────────────────

/**
 * Remove wards whose worktree is gone (the only path that deletes data) and stop
 * wards whose threads all went idle (settled, archived or deleted) after the
 * ward last started, so reopening a settled thread's terminal isn't undone.
 */
async function reconcile(): Promise<string[]> {
  const actions: string[] = [];
  let threads: Map<string, ThreadState[]> | undefined;
  try {
    threads = lastThreads = await threadsByWorktree();
  } catch (error) {
    log(`reconcile: cannot read T3 thread state: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const record of [...wards.values()]) {
    if (!existsSync(record.worktree)) {
      await rm(record.id);
      actions.push(`removed ${record.id}: worktree is gone`);
      continue;
    }
    const states = threads?.get(record.worktree) ?? [];
    const startedAt = startedAtById.get(record.id);
    // No thread uses this worktree (or T3 is unreachable): leave the ward alone.
    if (states.length === 0 || startedAt === undefined || !isReady(record.id)) continue;
    if (states.every((t) => t.idleSince !== undefined && t.idleSince > startedAt)) {
      await stop(record.id);
      actions.push(`stopped ${record.id}: its threads are settled, archived or deleted`);
    }
  }
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

const requireRecord = (id: string) => {
  const record = wards.get(id);
  if (record === undefined) throw new Error(`no ward ${id}`);
  return record;
};

const handlers: Handlers = {
  "POST /up": ({ worktree }) => up(worktree).finally(watchWorktreeParents),
  "POST /stop": async ({ id }) => ({ stopped: await stop(requireRecord(id).id) }),
  "POST /rm": async ({ id }) => ({ removed: await rm(requireRecord(id).id) }),
  "POST /port": async ({ id, port }) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
    requireRecord(id);
    return { host: await ensureListener(id, port) };
  },
  "POST /gc": async () => ({ actions: await runReconcile() }),
  "GET /ls": async () => [...wards.values()].map(info).sort((a, b) => a.slot - b.slot),
};

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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = `${req.method} ${req.url}`;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!(route in handlers)) return reply(404, { error: `unknown route ${route}` });
  try {
    const handler = handlers[route as Route] as (body: unknown) => Promise<unknown>;
    reply(200, await handler(await readBody(req)));
  } catch (error) {
    reply(500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function main(): void {
  mkdirSync(dirname(CONTROL_SOCKET), { recursive: true });
  rmSync(CONTROL_SOCKET, { force: true });
  const server = createHttpServer((req, res) => void handle(req, res));
  server.listen(CONTROL_SOCKET, () => log(`wardd listening on ${CONTROL_SOCKET}`));
  for (const record of wards.values()) {
    if (!isReady(record.id)) continue;
    startedAtById.set(record.id, new Date().toISOString());
    attach(record);
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
