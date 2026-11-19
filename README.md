<img src="assets/icon.svg" width="64" height="64" alt="">

# Ward

Gives every T3 Code worktree on gaia-arch its own network namespace, Podman and `TMPDIR`, so parallel agent threads can all run a dev server on 5173 and Postgres on 5432 without colliding, and a private headless desktop on demand, so they can each drive a GUI app without sharing your screen. [docs/DESIGN.md](docs/DESIGN.md) explains how, and [docs/PROFILE.md](docs/PROFILE.md) what it costs.

## Setup

Needs Linux with unprivileged user namespaces, Node 24+, `podman`, `passt`, `crun`, and subuid/subgid ranges for your user (`/etc/subuid`, `/etc/subgid`). Desktops also need `umbriel`, `dbus` (for `dbus-run-session`) and, for apps' text, `at-spi2-core`.

```sh
pnpm install
bin/ward install        # systemd user units, ward on PATH, read-only T3 token
ward enable <repo>      # opt a project in (folder name under ~/.t3/worktrees)
```

For T3 to run agent commands and terminals in wards, start the Annex server with `T3CODE_WARD_COMMAND=$HOME/.local/bin/ward`. Ward serves the T3 at `~/.t3`; set `WARD_T3_HOME` for another.

## Use

Inside a ward, services are at their usual `localhost` ports. From the host:

```sh
ward ls                 # wards, slots and port mappings
ward ports              # this worktree's ward port → host port
ward exec -- CMD        # run CMD in the current worktree's ward
ward desktop -- CMD     # run a GUI app on the ward's private desktop
ward stop | ward rm     # stop (keeps data) or remove a ward
ward images pull IMAGE  # pull into the image store every ward shares
```

Wards start on the first command in a worktree. They stop once every thread on it has settled, or 30 minutes after the last command when it has no active thread. When the worktree is deleted, the ward's data goes to a trash for 7 days.

### Desktops

`ward desktop -- CMD` runs `CMD` in the ward on a desktop of its own: a headless Umbriel with one 1280×720 output, its own session bus and no shell. It starts on the first `ward desktop` and stops with the ward. Nothing on it reaches your session's windows, cursor, notifications, portals or audio. [Puck](https://github.com/Axl47/puck)'s MCP tools act on it by default in a warded worktree; `ward desktop` alone prints its environment (`WAYLAND_DISPLAY` and the rest) for anything else that should.

Only the prefixed command is on that desktop: a GUI app started without it opens on your screen, as outside a ward. The prefixed command has no keyring, `systemctl --user` or audio, so build, commit and push without it. X11-only apps don't run there.

### Limits

Inside a ward, `sudo` doesn't work, and host services are reachable only on the ports in `WARD_HOST_PORTS` (default `3773,5037`, plus DNS) and the project's own, set with `ward enable <repo> --host-ports 39003,…`. The flag replaces the project's list, and a ward picks up a new list only when it next starts: `ward enable` names the running wards still on the old one (`ward stop` them to apply it now). A forwarded host port is taken inside the ward, so a server in the ward can't listen on it (`EADDRINUSE`). Port 53, Ward's own host ports (20100–29999) and lists over 200 ports in all are refused. In a ward, `WARD_FORWARDED_PORTS` lists what it reaches. `/tmp` and `XDG_RUNTIME_DIR` are the host's, shared by every ward, so keep per-worktree pid files and sockets in `TMPDIR`.

Connections through a mapped port end with a reset when their ward stops or `wardd` restarts, so a transfer in flight fails rather than looking complete.

## Upgrade

`git pull`, then `systemctl --user restart wardd`. The restart resets connections open through mapped ports; wards and what runs in them carry on. Running wards keep the settings they started with (their TCP table size, host ports) until they next start.

## Develop

```sh
pnpm typecheck && pnpm test
```
