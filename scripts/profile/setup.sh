#!/usr/bin/env bash
# setup.sh: build the fixture, its warded worktrees (p0 idle, p1..pN) and unwarded
# checkouts (h1..hN), install dependencies, and pull postgres:17 into both image
# stores so pulls stay out of the timings. Also measures what one ward pulling
# into its own store costs, before the shared store has the image.
source "$(dirname "$0")/lib.sh"
IMAGE=docker.io/library/postgres:17

[ -e "$REPO" ] || "$HERE/fixture.sh" "$REPO"
mkdir -p "$WT" "$HOSTDIR"
for i in $(seq 0 "$N"); do [ -e "$WT/p$i" ] || git -C "$REPO" worktree add -q --detach "$WT/p$i"; done
for i in $(seq 1 "$N"); do [ -e "$HOSTDIR/h$i" ] || git -C "$REPO" worktree add -q --detach "$HOSTDIR/h$i"; done
for d in "$WT"/p[1-9]* "$HOSTDIR"/h*; do (cd "$d" && pnpm install --silent); done

ward enable ward-profile

# A ward that pulls into its own store (shared store still empty).
{
  load
  ward exec --worktree "$WT/p0" -- docker pull -q "$IMAGE"
  pid=$(cat "$XDG_RUNTIME_DIR/ward/$(ward_id p0)/pid")
  echo "own-store ward storage after pull (KiB): $(nsenter -U -t "$pid" -- du -sx "$HOME/.local/state/ward/wards/$(ward_id p0)/storage" | cut -f1)"
} | tee "$OUT/pull-own-store.txt"
ward rm --now "$(ward_id p0)"

ward images pull -q "$IMAGE"
podman pull -q "$IMAGE"
