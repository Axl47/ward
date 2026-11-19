# Shared settings and helpers for the profile scripts. Source it.
# shellcheck shell=bash
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
N=${N:-4}
BASE=${PROFILE_BASE:-${XDG_CACHE_HOME:-$HOME/.cache}/ward-profile}
REPO=$BASE/repo                       # the fixture repo
HOSTDIR=$BASE/host                    # unwarded checkouts h1..hN
OUT=$BASE/results                     # raw measurements
WT=$HOME/.t3/worktrees/ward-profile   # warded worktrees p1..pN (p0: idle ward)
HOST_SLICE=wardprofilehost.slice  # transient slice for the unwarded run (a dash would nest it)
HOST_SOCK=$BASE/podman.sock           # host Podman API socket for the run
CG=/sys/fs/cgroup
USER_CG=$CG/user.slice/user-$(id -u).slice/user@$(id -u).service
WARDS_CG=$USER_CG/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-wards.slice
HOST_CG=$USER_CG/$HOST_SLICE
WARDD_CG=$USER_CG/app.slice/wardd.service
mkdir -p "$OUT"

# Ward id and cgroup of a warded worktree.
ward_id() { echo "ward-profile.$1"; }
ward_cg() { echo "$WARDS_CG/ward@$(ward_id "$1").service"; }
host_vite_port() { echo $((5173 + $1)); }
host_pg_port() { echo $((5432 + $1)); }

# Microseconds of CPU a cgroup has used.
cpu_usec() { awk '$1 == "usage_usec" { print $2 }' "$1/cpu.stat"; }
# Wall clock in microseconds.
now_us() { local t=$EPOCHREALTIME; echo "${t/./}"; }
# Run a command, print its wall time in ms.
time_ms() { local a b; a=$(now_us); "$@" >/dev/null 2>&1 || { echo "failed: $*" >&2; return 1; }; b=$(now_us); awk -v d=$((b - a)) 'BEGIN { printf "%.1f\n", d / 1000 }'; }
# Log the machine load next to a measurement.
load() { echo "# $(date +%T) load: $(cut -d' ' -f1-3 /proc/loadavg)"; }
# Stats over numbers on stdin: median and range.
stats() { node "$HERE/stats.ts" "$@"; }
# Host-mode environment for checkout i.
host_env() {
  echo "DOCKER_HOST=unix://$HOST_SOCK COMPOSE_PROJECT_NAME=wp-host-$1 VITE_PORT=$(host_vite_port "$1") PGPORT=$(host_pg_port "$1")"
}
