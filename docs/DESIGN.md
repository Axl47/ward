# Ward design

Status: approved 2026-11-19 and built. Where the build departed from the draft, this file now describes what was built.

## Problem

T3 gives each thread its own git worktree, so files don't collide. Everything else on gaia-arch is shared: the loopback port space (two Vite servers both want 5173), Docker (shared daemon, published ports, fixed `container_name`s), `/tmp`-based caches such as Metro's, and the adb server. Ward gives each worktree a private copy of those, created on demand and removed when the worktree goes away.

The threat model is accidental collision between trusted agents, not containment of a hostile one. That rules out microVMs as the default: they would buy security we don't need and cost file-system speed (virtiofs over `node_modules`) and nested KVM for emulators.

## What T3 offers today (Annex, verified by reading the code)

- Worktrees are created in `ThreadLaunchService` → `GitVcsDriverCore.createWorktree`, at `~/.t3/worktrees/<repo>/<branch-prefix>-<16 hex>`. The thread ↔ worktree link lives only in `statev2.sqlite` (`orchestration_v2_projection_threads.payload_json.$.worktreePath`).
- Removal happens on many paths: launch failure, UI remove, handoff failure, and an hourly storage-cleanup job. Thread archive and delete never remove the worktree. "Settle" is a flag on the thread, not a removal.
- `t3.json` scripts can run on worktree create and on settle, but only the first matching script runs, they are per project, they get no thread id, and nothing runs on removal.
- Claude and Codex get `T3CODE_THREAD_ID`; terminals have every `T3CODE_*` variable stripped.
- Annex already has a `PortScanner.PortDiscovery` service that watches agent-started ports.

So the hook Ward needs, wrapping every process a thread starts, doesn't exist. It belongs in Annex as one small hook; everything else, including reacting to worktree removal, lives in Ward.

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

- **Namespaces.** `unshare --user --net` with a custom ID map: your uid maps to itself (1000), so files in the worktree stay yours and nothing runs as root (Postgres `initdb` and Chromium's sandbox both refuse root); uid 0 and the rest map to your subuid range for the container engine. Proven on this machine with a single-uid map: a server bound inside is invisible to the host, processes that join see it, and files they create are owned by you. The full subuid map worked too. Because it is a user namespace, `sudo` and other setuid programs can't work inside; a `sudo` shim says so.
- **cgroup.** Each ward is a systemd user unit, `ward@<id>.service`, in `app-t3code-agents-wards.slice` so it shares the memory limit T3 puts on agents. `ward exec` moves the command into that cgroup before entering the namespaces, so stopping the unit (`KillMode=control-group`) kills every process the agent started, including daemonized dev servers and container processes, and gives per-ward CPU accounting. Containers run with Podman's cgroups disabled (crun, not runc), so they share the ward's cgroup.
- **Internet.** `pasta` (from `passt`), started as root inside the user namespace, attaches to the ward's netns for outbound traffic and forwards a short allow-list of host loopback services into it: DNS (the host's stub resolver), `WARD_HOST_PORTS`, default T3's server on 3773 and the adb server on 5037, and the project's own list, stored in its `ward enable` marker (`ward enable <repo> --host-ports 39003`). `wardd` writes each ward's combined list to its runtime folder when it starts, so a change applies when the project's wards next start.
- **Start errors.** journald drops what is written from inside the ward's user namespace, so the init scripts' stderr goes to `init.log` in the ward's runtime folder; `wardd` puts its tail into the error when a ward fails to start, and logs its warnings (such as a TCP sysctl it couldn't set) when it starts.
- **Containers.** Each ward runs its own Podman API service as root-inside-the-ward, in a private mount namespace with its own `/run` and `/var/lib/containers`. Agents use the normal `docker` / `docker compose` CLI via `DOCKER_HOST`. Published ports land in the ward's own loopback, so `docker run -p 5432:5432 postgres` just works in every ward at once. Each ward pulls into its own store by default; `ward images pull IMAGE` puts an image in a shared read-only store (Podman `additionalimagestores`) that every ward reads, so it's downloaded once. This also means you never need the root-equivalent `docker` group. Podman's healthchecks normally run from systemd timers, which a ward lacks, so `wardd` runs them at each container's configured interval (compose `depends_on: service_healthy` works). Builds use Docker's classic builder (`DOCKER_BUILDKIT=0`), since BuildKit's builder container needs a cgroup of its own. Container DNS (aardvark-dns) listens on port 1153, because 53 in the ward is pasta's DNS forward. Podman sees a private `/var/cache`, where root's Podman records short-name aliases, so `postgres:17` resolves as on the host. `ward stop` stops containers with a 10-second grace period (Docker's default, so a database can shut down cleanly) before stopping the unit, so one that ignores SIGTERM doesn't hold the stop for the unit's 15-second timeout and leave it failed. `wardd` follows each ward's Podman event stream and lists containers only on a change (and once per connect; a failed list is retried, backing off to 30 s), so an idle ward costs Podman nothing.
- **Caches.** Lock-safe content-addressed caches stay shared (pnpm store, Cargo registry, Gradle caches). Per-ward: `TMPDIR` (covers Metro, Vite and most tools), the container store, and volumes. `/tmp` itself is the host's: a tool that writes a fixed `/tmp/...` path shares it with every ward and the host. A private `/tmp` would take a mount namespace per ward that every command joins, and would cut the handoff of files through `/tmp` between agent commands in the ward and everything on the host (the agent's own file tools, T3, screenshots, X11 sockets), so Ward doesn't make one.

## Ports

No allocation inside the ward: every ward can use any port, including hardcoded ones. Allocation only exists at the boundary, for things outside the ward that need to reach in (your browser, T3's preview browser, emulators).

- Each ward gets a slot N and a host block `20000 + 100·N … +99` (below the ephemeral range 32768+).
- `wardd` watches the ward's listening sockets (`/proc/<pid>/net/tcp*` is per-netns) and maps each new one to the next free port in the block, stable for the ward's life: ward `:5173` → host `127.0.0.1:20103`. Each ward's namespace gets a TCP hash table of its own (4096 buckets), so these once-a-second reads don't walk the host's table; the two limits the kernel derives from the table's size (`tcp_max_tw_buckets`, `tcp_max_syn_backlog`) are set back to the host's values, or a load test in a ward would overflow TIME_WAIT.
- Mechanism: `wardd` listens on the host port itself. For each incoming connection, a tiny broker process inside the ward (joined with `nsenter`, talking over Node IPC) dials the ward port and passes the connected socket back, without reading from it. The broker carries no traffic, but `wardd` copies every byte between the two connections in userspace (half-close included), which costs about 22 % of keep-alive throughput and 16 % on a large download against the ward's port reached from inside it ([PROFILE.md](PROFILE.md)). Decided: that cost is accepted, not a to-do. A later live test measured 2.14 GB/s through a mapped port against 2.20 GB/s direct for 1 GiB with `curl`, and 517 ms against 452 ms for 5000 new connections; a dev server never needs more. The listener keeps half-close (a client can send FIN and still read the reply, and so can a server), and when the ward stops or `wardd` exits its connections are reset rather than ended, so a client can't mistake a cut-off download for a complete one; a `wardd` restart drops connections in flight. The profile once saw a 64 MiB download through a mapped port hang; it was never reproduced: not in 200 runs of the same download through the broker and copy path in `test/forward.test.ts`'s harness, nor through live mapped ports since. Ruled out: the half-close handling (fixed, and pinned by tests) and loss in the broker (it never reads from the socket it hands over). Ports Podman publishes are DNAT rules rather than listening sockets, so `wardd` also follows the ward's Podman event stream and asks which ports its containers publish whenever one starts or stops.
- Mappings live in `~/.local/state/ward/registry.json`. When a ward port stops listening, its host listener closes (connections are refused, not reset) but keeps its number. When a ward's block of 100 is full, a mapping whose ward port stopped listening is released.
- Host ports bind 127.0.0.1 only, so other devices on the LAN or tailnet can't reach a ward's servers.

## How an agent finds its ports and services

Mostly it doesn't need to: inside the ward, services are at their usual `localhost` ports. The ward's env carries `WARD_ID`, `WARD_ROOT`, `DOCKER_HOST`/`CONTAINER_HOST` and a per-ward `TMPDIR`; T3's device tools still set `ANDROID_SERIAL`. For the only thing that differs, host-visible URLs, `ward ports` prints the mapping and `ward port 5173` maps one on demand. Nothing is written into the worktree, so `git status` stays clean. A note in the global agent instructions says this, and that the preview browser needs the host URL, since it runs outside the ward.

An MCP tool isn't needed in v1. T3's port list shows each ward port at its host address, attributed to the worktree's thread.

## Emulators

T3's device tools stay the source of truth for who holds which AVD; Ward doesn't add a second lease. (The research found per-thread sessions for local Android but no cross-thread lock; the agent tests will check this, and if it's missing the fix goes into Annex's `DeviceService`, not into Ward.) Ward adds the network plumbing: the ward reaches the host adb server through pasta, and a small `adb` shim rewrites `adb reverse tcp:8081 tcp:8081` to target the ward's mapped host port, so the app on the emulator reaches the ward's Metro. The shim is first on the ward's `PATH`, and the ward's `ANDROID_HOME` is an overlay of the real SDK whose `platform-tools/adb` is the shim, since React Native and Expo call adb by that path. Emulators keep running on the host with KVM; nothing about them needs to change when SVM comes on.

## Desktops

Goal, in the words of the request (2026-11-19): "give each ward its own headless Umbriel desktop, so parallel agents can drive and verify GUI apps with Puck without fighting over my one live session and cursor. […] Apps the agent launches open there, and Puck's tools […] act on that desktop instead of mine. My live session stays the default when there's no ward, or when the agent explicitly asks for it. […] A per-ward instance must not steal or disturb my live session's bus names, notifications, portals or audio. […] start the desktop lazily on first use, stop it with the ward, and make it reachable from agent commands inside the ward."

A ward's desktop is three things in one folder, `$XDG_RUNTIME_DIR/ward/<id>/desktop`, which is the desktop's own `XDG_RUNTIME_DIR`:

```
ward "indexio/t3-d7059d66…"                         host
┌───────────────────────────────────────────┐      ┌──────────────────────────────┐
│ dbus-daemon (the desktop's session bus)   │      │ Puck's MCP server            │
│  └ at-spi-bus-launcher, at-spi2-registryd │◀─────┤  asks `ward desktop` for the │
│ umbriel, headless: HEADLESS-1 1280×720    │ unix │  env, then runs umbriel,     │
│  └ apps: `ward desktop -- CMD`,           │ sock │  grim and AT-SPI with it     │
│    Puck's launch_app                      │      │ live Umbriel + Noctalia:     │
└───────────────────────────────────────────┘      │  never contacted             │
                                                   └──────────────────────────────┘
```

- **A session bus of its own.** Everything a desktop shares with the live session goes through the session D-Bus and `XDG_RUNTIME_DIR`: bus names, notifications, portals, the tray, single-instance apps (a GTK app started on the live bus hands its window to the instance already running on your screen), the accessibility bus, PipeWire's socket, and Umbriel itself, which publishes `WAYLAND_DISPLAY` and `UMBRIEL_SOCKET` into the systemd user manager over that bus when it starts. So the desktop gets a `dbus-daemon` whose config lists one service folder holding one file, the accessibility bus, started with accessibility on. Nothing else can be activated on it: no portal, keyring, notification daemon or dconf writer. With no systemd and no PipeWire socket in its runtime folder, Umbriel's publish step finds no manager to talk to and apps have no audio.
- **Umbriel, headless.** `WLR_BACKENDS=headless umbriel -c <its own config>`: no autostart, so no Noctalia shell, bar or notifications, and none of your keybinds. It makes one 1280×720 output, `HEADLESS-1`; `ward desktop -- umbriel output-create NAME 1920x1080` adds more.
- **Inside the ward.** `wardd` starts it through `ward exec`, so it runs in the ward's namespaces and cgroup. Apps the compositor starts (Puck's `launch_app`) are therefore in the ward too and reach its `localhost` ports, and stopping the ward stops the desktop with everything on it. Its sockets are path sockets under the host's `/run/user`, so tools on the host connect to them like any others.
- **Accessibility.** `at-spi-bus-launcher` runs the accessibility bus with `dbus-broker` when it can, and `dbus-broker` starts services through systemd, which the desktop doesn't have. So the registry (`at-spi2-registryd`) is started with the desktop rather than on demand; without it apps never register and Puck's `inspect` falls back to OCR.
- **Lazy.** Nothing runs until the first `ward desktop`, which asks `wardd` to start the ward if needed and then the desktop, and waits until the compositor is up and the registry is on the accessibility bus: 0.4 s in all, and about 70 MB of memory (PSS) while it runs, nearly all of it Umbriel. `bin/ward` answers later calls itself from the desktop's `env` and `pid` files, without Node, in 8 ms. Its output goes to `desktop.log` in the ward's runtime folder.

### How a command gets on it

One rule, the usual Wayland one: a process is on the desktop its environment names (`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `UMBRIEL_SOCKET`, `DBUS_SESSION_BUS_ADDRESS`). `ward desktop` prints the ward desktop's, and `ward desktop -- CMD` runs `CMD` in the ward with it. Puck follows the same rule, so `ward desktop -- puck state` reads the ward's desktop and a bare `puck state` the live one. Puck's MCP server can't be prefixed per call (it is one process outside the ward for the whole thread), so it asks `ward desktop` itself when its folder is a warded worktree, and `desktop_state` with `desktop: "live"` moves that session to your screen.

Decided against:

- **Putting the desktop in every ward command's environment**, so a bare `cargo run` would open there. The ward's commands would then lose the live session bus, and `gh` keeps its token in the keyring on that bus (`gh auth status`: "keyring"), as does `git push` through it. A GUI app half in (ward's Wayland socket, live bus) is worse: its notifications, tray icon and single-instance hand-off land on your screen.
- **Making un-prefixed GUI launches fail in a ward**, by pointing `WAYLAND_DISPLAY` nowhere. Miranda, the first warded project, watches the live session on purpose and finds it through the one socket in `XDG_RUNTIME_DIR` when `WAYLAND_DISPLAY` is unset. So a GUI program started in a ward without the prefix still opens on your screen, as before.
- **A Noctalia shell on the desktop.** It claims bus names and talks to NetworkManager, logind and PipeWire, and an agent checking an app needs none of it. Puck's notification and shell-setting tools say so on a ward's desktop.

Limits: under `ward desktop --`, `XDG_RUNTIME_DIR` is the desktop's folder, so that command has no keyring, `systemctl --user`, gpg-agent or host PipeWire; start the app with it, and build, commit and push without it. (`$XDG_RUNTIME_DIR/ward` links back to Ward's own runtime folder, so `ward` still works there.) The folder's path plus a socket name must fit in 108 bytes, which holds for project folder names up to about 25 characters; longer ones get an error instead of a desktop. There is no Xwayland: it refuses `/tmp/.X11-unix`, whose owner (the host's root) is nobody inside the ward's user namespace, so X11-only apps don't run on a ward's desktop, and `DISPLAY` is empty there so they can't reach the live session's instead.

## Lifecycle and teardown

| Event | Ward action |
| --- | --- |
| First command in a worktree (lazy) | `up`: create namespaces, unit, slot, Podman service |
| Every thread on the worktree settled, and the latest settled after the ward's last start, command, or terminal input, or none of those for 30 minutes | `stop`: kill processes (open terminals included) and containers, release host ports; keep volumes so the next command resumes |
| No active thread on the worktree (its threads were archived or deleted) and no command for 30 minutes | `stop` |
| Worktree removed | `rm`: move the ward's data, including the container store and volumes, to a trash; it comes back if the same worktree reappears within 7 days, then it is purged. `ward rm` also uses the trash; `ward rm --now` deletes at once |

`wardd` runs a reconciler every minute, plus within about two seconds of a change in a warded repo's worktree folder. It reads thread state from T3's orchestration API (`GET /api/orchestration/shell`) with a read-only `orchestration:read` token in `~/.config/ward/t3-token`, and applies the table above. T3's list leaves out archived and deleted threads, so those count as "no active thread". Deleting a thread only stops its ward, because the worktree, and so the work, may outlive it; only a worktree that is gone removes data, and only while the worktrees folder itself exists. If T3 is unreachable, nothing is stopped. Each ward's last start and last command are kept as file times, so restarting `wardd` doesn't reset them. A stop costs little: the next command starts the ward again, though services must be restarted (compose `restart:` policies don't apply). When all 99 slots are taken, a new ward takes the slot of the stopped ward unused longest, and that ward gets a new slot and new host ports when it next starts. The reconciler also re-attaches port mapping for running wards whose broker died.

## The Annex change

Ward needs no lifecycle hooks from T3: wards start lazily on the first command, and the reconciler handles stop and removal. So the Annex change is only the process wrapping, behind one env var, `T3CODE_WARD_COMMAND` (the `ward` executable), in a new `apps/server/src/ward/Ward.ts` with one-line seams:

- Claude gets `CLAUDE_CODE_SHELL_PREFIX=ward-prefix`. Claude Code runs MCP servers, hooks and LSP servers through the same prefix, so `ward-prefix` sends only Bash tool commands (the ones that source a shell snapshot) into the ward. The Claude process, its API traffic and MCP stay on the host. If Claude Code stops using shell snapshots, its commands silently run on the host again.
- Codex runs one app-server per thread, but its commands go through `bash -c`, so it gets `BASH_ENV=ward-bash-env`, which re-runs the command in the ward when the working folder is a warded worktree. Inside Codex's own sandbox (its non-full-access modes), which has its own namespaces and can't reach `wardd`, the hook leaves commands alone.
- Integrated terminals are launched as `ward exec --worktree <cwd> -- <shell>`.
- The port scanner replaces `wardd`'s host sockets with one entry per ward port, attributed to the worktree's thread.

Every hook passes through untouched for folders that aren't warded worktrees, so non-worktree threads and projects without `ward enable` behave as before.

## Code shape

TypeScript on Node 24 (run directly, no build step), one package: the `ward` CLI and the `wardd` user daemon. Node's IPC can pass socket handles between processes, which covers the fd broker without native code. `ward exec` is a small POSIX shell script on the hot path (cgroup move + `nsenter`), since it runs on every agent command.

System changes on gaia-arch, recorded in omarchy-config: install `podman`, `passt` and `crun`; subuid/subgid ranges for the user; enable `wardd.service` (user unit).

## Risks and limits

1. **Podman as root inside a custom user namespace** worked, with cgroups disabled, crun, file event logging, and a private `/run`.
2. **`sudo` doesn't work inside a ward** (setuid binaries can't run in a user namespace). Wards are opt-in per project (`ward enable <repo>`), so projects that need system changes simply don't enable them.
3. **Codex** runs one app-server per thread, but wrapping the app-server would put its API traffic and MCP in the ward too, so the `BASH_ENV` hook wraps its commands instead.
4. **Ward's view of T3.** Ward serves `~/.t3` (or `WARD_T3_HOME`), not `T3CODE_HOME`, which T3 dev servers point at their own state. T3's configurable worktrees folder isn't followed.
5. **Processes leave T3's per-thread scope.** Ward commands move into the ward's unit, so T3's thread kill no longer reaches dev servers an agent started; stopping the ward does.
6. **Emulators** were not tested end to end: `/dev/kvm` is absent until SVM is turned on. The adb path (host server reachable from a ward, `adb reverse` rewrite) is tested without a device.
7. **`XDG_RUNTIME_DIR` is shared** between wards and the host, since Wayland, PipeWire and the session bus live there. Two worktrees of an app that keeps a pid file or socket there collide; such files belong in `TMPDIR`, which is per ward.

## Verification

Three Claude subagents in three real T3 worktrees of a small test app, in parallel: each starts a dev server on the same port, `docker compose up` Postgres on 5432, writes a row, and checks it reaches its own services. Pass means: no port errors, each sees only its own row, each ward's dev server answers on its own host port, `ward rm` leaves no processes, containers or ports behind, and the reconciler cleans up a worktree removed by hand.

Desktops, verified in a second Ward instance (2026-11-19): two wards started their desktops in parallel from Puck's first MCP call; each ran its own instance of one GTK app (same application id) and of Evince; Puck's `screenshot`, `inspect` (accessibility text), `launch_app` and `move_window` acted on each ward's own desktop from outside the ward; and the live session's windows, focus, bar, notifications, bus names, accessibility apps and systemd environment were the same before and after.

Verified since, with real T3 threads building a real project in parallel wards (2026-11-19): a settled thread's ward stopped 4 seconds after the settle; a merged thread's worktree removed by T3 sent its ward to the trash within seconds; Wayland screenshots, PipeWire recording, the accessibility bus and the GPU all work from inside a ward. Still unverified: emulators, until KVM.
