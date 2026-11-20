<img src="assets/icon.svg" width="64" height="64" alt="">

# Ward

Gives every T3 Code worktree on gaia-arch its own network namespace, Podman and `TMPDIR`, so parallel agent threads can all run a dev server on 5173 and Postgres on 5432 without colliding, and a private headless desktop on demand, so they can each drive a GUI app without sharing your screen. [docs/DESIGN.md](docs/DESIGN.md) explains how, and [docs/PROFILE.md](docs/PROFILE.md) what it costs.

## Setup

Needs Linux with unprivileged user namespaces, Node 26+ (`wardd` reads callers' credentials through `node:ffi`), `podman`, `passt`, `crun`, `xdg-dbus-proxy` (the session bus a ward sees), and subuid/subgid ranges for your user (`/etc/subuid`, `/etc/subgid`). Desktops also need `umbriel`, `dbus-daemon`, `at-spi2-core` for apps' text, and `wtype` for typing into them; with [Caliban](https://github.com/Axl47/caliban) installed they also get a sound server of their own.

```sh
pnpm install
bin/ward install        # systemd user units, ward on PATH, read-only T3 token
ward enable <repo>      # opt a project in (its folder name under T3's worktrees folder)
```

For T3 to run agent commands and terminals in wards, start the Annex server with `T3CODE_WARD_COMMAND=$HOME/.local/bin/ward`. Ward serves the T3 at `~/.t3`; set `WARD_T3_HOME` for another.

## Use

Inside a ward, services are at their usual `localhost` ports. From the host:

```sh
ward ls                 # wards, slots and port mappings
ward ports              # this worktree's ward port → host port
ward exec -- CMD        # run CMD in the current worktree's ward
ward desktop -- CMD     # run a GUI app on a private desktop: the ward's, or the T3 thread's own
ward stop | ward rm     # stop (keeps data) or remove a ward
ward images pull IMAGE  # pull into the image store every ward shares
```

Wards start on the first command in a worktree. They stop once every thread on it has settled, or 30 minutes after the last command when it has no active thread. When the worktree is deleted, the ward's data goes to a trash for 7 days.

### Desktops

`ward desktop -- CMD` runs `CMD` in the ward on a desktop of its own: a headless Umbriel with one 1280×720 output, its own session bus and no shell. It starts on the first `ward desktop` and stops with the ward. It shares no compositor, session bus, notifications, portals or sound server with your session (apps on it play nothing, or into a sink of its own when Caliban is installed), and apps get a profile of their own there: its config folder mirrors `~/.config` with links to your files, minus browser and Electron profiles, and what an app creates stays in the ward. [Puck](https://github.com/Axl47/puck) acts on it by default for an agent in a ward; `ward desktop` alone prints its environment (`WAYLAND_DISPLAY` and the rest) for anything else that should. Its log is `desktop.log` in the ward's data folder.

Where a T3 thread has no ward, the same command gives the thread a desktop of its own: the same desktop without the network namespace, so apps on it reach the thread's `localhost` ports directly. It starts with the first `ward desktop -- CMD` (plain `ward desktop` prints nothing until then, and exits 3). It stops when the thread settles or after 2 hours unused, keeping nothing, and the thread's next call starts it again, empty. Agents open things through Puck's `puck open CMD`, which runs this, waits for the window and prints it.

Only the prefixed command is on that desktop: a GUI app started without it opens on your screen, and outside both a ward and a T3 thread the prefixed command fails rather than opening there. The prefixed command has no keyring or `systemctl --user`, so build, commit and push without it. A plain `ward exec` command still plays sound through your session's PipeWire, out of your speakers. X11-only apps don't run there. The rest of your home folder is shared, so an app that finds its running copy through files there still reaches the one on your screen: a Firefox with its profile in `~/.mozilla` refuses to start beside it (give it `--profile DIR`), and Zed keeps a socket in `~/.local/share/zed`.

### Limits

Inside a ward, `sudo` doesn't work, and host services are reachable only on the ports in `WARD_HOST_PORTS` (default `3773,5037`, plus DNS) and the project's own, set with `ward enable <repo> --host-ports 39003,…`. The flag replaces the project's list, and a ward picks up a new list only when it next starts: `ward enable` names the running wards still on the old one (`ward stop` them to apply it now). A forwarded host port is taken inside the ward, so a server in the ward can't listen on it (`EADDRINUSE`). Port 53, Ward's own host ports (20100–29999) and lists over 200 ports in all are refused. In a ward, `WARD_FORWARDED_PORTS` lists what it reaches. From inside a ward, `ward` can only map that ward's ports, start its desktop and list it; stopping, removing or starting wards, and anything about another ward, is for the host. `/tmp` and `XDG_RUNTIME_DIR` are the host's, shared by every ward, so keep per-worktree pid files and sockets in `TMPDIR`. Inside a ward there is no `systemctl --user` and the session bus reaches only the keyring; Ward's own state, config and checkout are read-only; and Ward's T3 token and T3's `userdata` (except `attachments`) are hidden. [DESIGN.md](docs/DESIGN.md) lists what a ward can still reach on purpose.

Connections through a mapped port end with a reset when their ward stops or `wardd` restarts, so a transfer in flight fails rather than looking complete.

## Upgrade

`git pull`, then `systemctl --user restart wardd`, and `bin/ward install` again when `units/` changed. The restart resets connections open through mapped ports; wards and what runs in them carry on. Running wards keep the settings they started with (their TCP table size, host ports) until they next start.

## Develop

```sh
pnpm typecheck && pnpm test
```
