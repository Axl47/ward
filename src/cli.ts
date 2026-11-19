// The `ward` CLI, except `ward exec` (bin/ward handles that in shell).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { call, WardError, type WardInfo } from "./api.ts";
import { CONTROL_SOCKET, enabledMarker, locate, WARD_HOME, wardRuntimeDir } from "./paths.ts";

const USAGE = `usage: ward <command>

  exec [--worktree DIR] -- CMD...   run CMD in the worktree's ward
  up [--worktree DIR]               start the worktree's ward
  stop [ID|--worktree DIR]          stop a ward, keeping its data
  rm [ID|--worktree DIR]            remove a ward and all its data
  ls [--json]                       list wards
  ports [--json]                    this ward's port mappings (ward port → host port)
  port PORT                         host port for a ward port, mapping it if needed
  env                               this ward's environment
  enable [REPO] / disable [REPO]    turn wards on or off for a project
  gc                                run the reconciler now
  images ARGS...                    podman on the shared image store, e.g. images pull postgres:17
  install                           install the systemd units and put ward on PATH`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    worktree: { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
  },
});
const [command, ...args] = positionals;
const flag = (name: "worktree") => (typeof values[name] === "string" ? (values[name] as string) : undefined);

/** The ward this command is about: explicit id, --worktree, $WARD_ID, or the current folder. */
function currentId(explicit?: string): string {
  if (explicit) return explicit;
  const worktree = flag("worktree");
  if (worktree === undefined && process.env.WARD_ID) return process.env.WARD_ID;
  const location = locate(worktree ?? process.cwd());
  if (location === undefined) throw new WardError("not inside a T3 worktree; pass a ward id or --worktree");
  return location.id;
}

async function ensureDaemon(): Promise<void> {
  if (existsSync(CONTROL_SOCKET)) return;
  spawnSync("systemctl", ["--user", "start", "wardd.service"], { stdio: "inherit" });
  for (let i = 0; i < 100 && !existsSync(CONTROL_SOCKET); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(CONTROL_SOCKET)) throw new WardError("wardd is not running; run `ward install` or `systemctl --user start wardd`");
}

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
  for (const bin of ["ward", "ward-prefix"]) {
    rmSync(join(binDir, bin), { force: true });
    symlinkSync(join(WARD_HOME, "bin", bin), join(binDir, bin));
  }
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", "wardd.service"]);
  execFileSync("systemctl", ["--user", "restart", "wardd.service"]);
  console.log(`installed units in ${unitDir} and ward, ward-prefix in ${binDir}`);
}

function repoArg(): string {
  const explicit = args[0];
  if (explicit) return explicit;
  const location = locate(process.cwd());
  if (location) return location.repo;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0) return basename(top.stdout.trim());
  throw new WardError("pass a project name (the folder name under ~/.t3/worktrees)");
}

async function main(): Promise<void> {
  switch (command) {
    case "up": {
      await ensureDaemon();
      const result = await call("POST /up", { worktree: flag("worktree") ?? process.cwd() });
      if (!result.enabled) {
        if (!values.quiet) console.log(result.reason);
        return;
      }
      if (!values.quiet) console.log(`${result.ward.id} is up (slot ${result.ward.slot})`);
      return;
    }
    case "stop":
    case "rm": {
      await ensureDaemon();
      const id = currentId(args[0]);
      const result = command === "stop" ? await call("POST /stop", { id }) : await call("POST /rm", { id });
      console.log(`${id}: ${"stopped" in result ? (result.stopped ? "stopped" : "was not running") : "removed"}`);
      return;
    }
    case "ls": {
      await ensureDaemon();
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
    case "env":
      process.stdout.write(readFileSync(join(wardRuntimeDir(currentId()), "env"), "utf8"));
      return;
    case "enable":
    case "disable": {
      const repo = repoArg();
      const marker = enabledMarker(repo);
      if (command === "enable") {
        mkdirSync(join(marker, ".."), { recursive: true });
        writeFileSync(marker, "");
      } else rmSync(marker, { force: true });
      console.log(`wards ${command}d for ${repo}`);
      return;
    }
    case "gc": {
      await ensureDaemon();
      const { actions } = await call("POST /gc", {});
      console.log(actions.length ? actions.join("\n") : "nothing to do");
      return;
    }
    case "images": {
      const result = spawnSync(join(WARD_HOME, "libexec/ward-images"), args, { stdio: "inherit" });
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
