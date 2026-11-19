# Ward

Gives every T3 Code worktree on gaia-arch its own network namespace, Podman and `/tmp`, so parallel agent threads can all run a dev server on 5173 and Postgres on 5432 without colliding. [docs/DESIGN.md](docs/DESIGN.md) explains how.

## Setup

Needs Linux with unprivileged user namespaces, Node 24+, `podman`, `passt`, `crun`, and subuid/subgid ranges for your user (`/etc/subuid`, `/etc/subgid`).

```sh
pnpm install
bin/ward install        # systemd user units, ward on PATH, read-only T3 token
ward enable <repo>      # opt a project in (folder name under ~/.t3/worktrees)
```

For T3 to run agent commands and terminals in wards, start the Annex server with `T3CODE_WARD_COMMAND=$HOME/.local/bin/ward`.

## Use

Inside a ward, services are at their usual `localhost` ports. From the host:

```sh
ward ls                 # wards, slots and port mappings
ward ports              # this worktree's ward port → host port
ward exec -- CMD        # run CMD in the current worktree's ward
ward stop | ward rm     # stop (keeps data) or remove a ward
ward images pull IMAGE  # pull into the image store every ward shares
```

Wards start on the first command in a worktree, stop when every thread on it is settled, archived or deleted, and are removed with their data when the worktree is deleted.

## Develop

```sh
pnpm typecheck && pnpm test
```
