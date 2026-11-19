# Ward design

Status: draft for review (2026-11-19).

## Problem

T3 gives each thread its own git worktree, so files don't collide. Everything else on gaia-arch is shared: the loopback port space (two Vite servers both want 5173), Docker (shared daemon, published ports, fixed `container_name`s), `/tmp`-based caches such as Metro's, and the adb server. Ward gives each worktree a private copy of those, created on demand and removed when the worktree goes away.

The threat model is accidental collision between trusted agents, not containment of a hostile one. That rules out microVMs as the default: they would buy security we don't need and cost file-system speed (virtiofs over `node_modules`) and nested KVM for emulators.

## What T3 offers today (Annex, verified by reading the code)

- Worktrees are created in `ThreadLaunchService` → `GitVcsDriverCore.createWorktree`, at `~/.t3/worktrees/<repo>/<branch-prefix>-<16 hex>`. The thread ↔ worktree link lives only in `statev2.sqlite` (`orchestration_v2_projection_threads.payload_json.$.worktreePath`).
- Removal happens on many paths: launch failure, UI remove, handoff failure, and an hourly storage-cleanup job. Thread archive and delete never remove the worktree. "Settle" is a flag on the thread, not a removal.
- `t3.json` scripts can run on worktree create and on settle, but only the first matching script runs, they are per project, they get no thread id, and nothing runs on removal.
- Claude and Codex get `T3CODE_THREAD_ID`; terminals have every `T3CODE_*` variable stripped.
- Annex already has a `PortScanner.PortDiscovery` service that watches agent-started ports.

So the hooks Ward needs (wrap every process a thread starts, react to worktree removal) don't exist. They belong in Annex as one small, generic hook; everything else lives in Ward.

## The isolation unit: one ward per worktree

A ward is an unprivileged Linux **user + network namespace** pair (no root, no setuid). Keyed by worktree, because two threads on one worktree already share files.

```
host (init namespaces)                         ward "indexio/t3-d7059d66…"
┌───────────────────────────────┐              ┌──────────────────────────────────┐
│ T3 server ── spawns ──────────┼─ ward exec ─▶│ agent shell commands, dev server │
│                               │  (nsenter +  │ :5173, Metro :8081               │
│ wardd (user service)          │   cgroup)    │ podman API ─▶ postgres :5432     │
│  · host port block 20100-199 ◀┼── fd broker ─┤ its own 127.0.0.1, own ports     │
│  · reconciler                 │              │ pasta: internet + host :5037(adb)│
│ adb server :5037, emulators   │              └──────────────────────────────────┘
└───────────────────────────────┘
```

- **Namespaces.** `unshare --user --net` with a custom ID map: your uid maps to itself (1000), so files in the worktree stay yours and nothing runs as root (Postgres `initdb` and Chromium's sandbox both refuse root); uid 0 and the rest map to your subuid range for the container engine. Proven on this machine with a single-uid map: a server bound inside is invisible to the host, processes that join see it, and files they create are owned by you. The full subuid map is part of the spike below.
- **cgroup.** Each ward is a systemd user unit, `ward@<id>.service`, with `Delegate=yes`. `ward exec` moves the command into that cgroup before entering the namespaces, so stopping the unit kills every process the agent started, including daemonized dev servers, and gives per-ward CPU/memory accounting and limits.
- **Internet.** `pasta` (from `passt`) attaches to the ward's netns for outbound traffic, and forwards a short allow-list of host loopback services into it (adb server 5037).
- **Containers.** Each ward runs its own Podman API service as root-inside-the-ward. Agents use the normal `docker` / `docker compose` CLI via `DOCKER_HOST`. Published ports land in the ward's own loopback, so `docker run -p 5432:5432 postgres` just works in every ward at once. Images are pulled once into a shared read-only store (Podman `additionalimagestores`), so wards don't re-download. This also means you never need the root-equivalent `docker` group.
- **Caches.** Lock-safe content-addressed caches stay shared (pnpm store, Cargo registry, Gradle caches). Per-ward: `TMPDIR` (covers Metro, Vite and most tools), the container store, and volumes.

## Ports

No allocation inside the ward: every ward can use any port, including hardcoded ones. Allocation only exists at the boundary, for things outside the ward that need to reach in (your browser, T3's preview browser, emulators).

- Each ward gets a slot N and a host block `20000 + 100·N … +99` (below the ephemeral range 32768+).
- `wardd` watches the ward's listening sockets (`/proc/<pid>/net/tcp*` is per-netns) and maps each new one to the next free port in the block, stable for the ward's life: ward `:5173` → host `127.0.0.1:20103`.
- Mechanism: a tiny broker process inside the ward creates listening and connected sockets there and hands the file descriptors to `wardd` (Unix-socket fd passing), so `wardd` owns all the plumbing and no traffic goes through the broker.

## How an agent finds its ports and services

Mostly it doesn't need to: inside the ward, services are at their usual `localhost` ports. The ward's env carries `WARD_ID`, `DOCKER_HOST`, `TMPDIR` and, once the thread holds a device, `ANDROID_SERIAL`. For the only thing that differs, host-visible URLs, `ward ports` prints the mapping (also in `$WARD_DIR/ports.json`). Nothing is written into the worktree, so `git status` stays clean. A one-line note in the global agent instructions says this.

An MCP tool isn't needed in v1; the Annex hook below makes it redundant by translating preview URLs.

## Emulators

T3's device tools stay the source of truth for who holds which AVD; Ward doesn't add a second lease. (The research found per-thread sessions for local Android but no cross-thread lock; the agent tests will check this, and if it's missing the fix goes into Annex's `DeviceService`, not into Ward.) Ward adds the network plumbing: the ward reaches the host adb server through pasta, and a small `adb` shim on the ward's `PATH` rewrites `adb reverse tcp:8081 tcp:8081` to target the ward's mapped host port, so the app on the emulator reaches the ward's Metro. Emulators keep running on the host with KVM; nothing about them needs to change when SVM comes on.

## Lifecycle and teardown

| Event | Ward action |
| --- | --- |
| First command in a worktree (lazy) or worktree create/restore | `up`: create namespaces, unit, slot, Podman service |
| Thread settles | `stop`: kill processes and containers, release host ports; keep volumes so unsettling resumes |
| Worktree removed, or its thread deleted | `rm`: destroy everything, including the container store and volumes |

Because worktrees are removed on many paths, `wardd` also runs a reconciler (every minute, plus inotify on `~/.t3/worktrees`) that reads `statev2.sqlite` read-only and applies the table above. The Annex hook makes it immediate; the reconciler makes it correct even when the hook doesn't fire (manual `git worktree remove`, crashes).

## The Annex change

One generic, Ward-agnostic hook, so Annex stays easy to rebase on upstream:

- A server setting `threadEnvironment.command` (e.g. `ward`). When set, Annex runs `<cmd> up|stop|rm --worktree <path> --thread <id>` at the lifecycle points above (one funnel in `GitVcsDriverCore.removeWorktree` covers every removal path).
- Every process Annex starts for a worktree is prefixed with `<cmd> exec --worktree <path> --`: integrated terminals, project scripts, and the Codex app-server when it's per-thread. For Claude, Annex sets `CLAUDE_CODE_SHELL_PREFIX` in the thread's spawn env, so the Claude process stays on the host (its API traffic and MCP untouched) while every Bash command runs in the ward.
- Preview: for a ward thread, `preview_open` and `t3.json` `previewUrl` rewrite `localhost:<port>` to the mapped host port, and `PortDiscovery` reads mappings from `ward ports`.

Until that ships, Ward is usable by hand (`ward exec -- …`), which is how the parallel agent tests will run first.

## Code shape

TypeScript on Node 22, one package: the `ward` CLI and the `wardd` user daemon. Node's IPC can pass socket handles between processes, which covers the fd broker without native code. `ward exec` is a small POSIX shell script on the hot path (cgroup move + `nsenter`), since it runs on every agent command.

System changes on gaia-arch, recorded in omarchy-config: install `podman` and `passt`; enable `wardd.service` (user unit).

## Risks and the spike that comes first

1. **Podman as root inside a custom user namespace** (overlay storage, netavark firewall rules inside the netns, cgroups disabled per container). If this fights back, the fallback is a per-ward rootless `dockerd` in the same namespaces; nothing else in the design changes.
2. **`sudo` doesn't work inside a ward** (setuid binaries can't run in a user namespace). Agents that need system changes would need an escape hatch, e.g. `ward host -- <cmd>` going through `wardd`, or Annex keeping a project-level opt-out (projects like omarchy-config don't need wards at all). I'd make wards opt-in per project.
3. **Codex**: if one app-server serves several threads, wrapping it per thread doesn't work and Codex commands need a different path. To confirm while building the Annex hook.

## Verification plan

Three Claude subagents in three real T3 worktrees of a small test app, in parallel: each starts Vite on 5173, `docker compose up` Postgres on 5432, writes a row, and reaches the dev server from an emulator through `adb reverse`. Pass means: no port errors, each sees only its own row, each emulator loads its own ward's page, `ward rm` leaves no processes, containers or ports behind, and the reconciler cleans up a worktree removed by hand.
