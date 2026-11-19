#!/usr/bin/env bash
# start.sh warded|host: bring up the container engines with nothing running.
#   warded: `ward up` each worktree's ward (namespaces, pasta, Podman service).
#   host:   a Podman API service on a private socket, in a transient scope in
#           $HOST_SLICE; compose.host.yaml puts the containers in that slice too.
source "$(dirname "$0")/lib.sh"
case $1 in
  warded) for i in $(seq 1 "$N"); do ward up --worktree "$WT/p$i" --quiet; done ;;
  host)
    printf 'services:\n  db:\n    cgroup_parent: %s\n' "$HOST_SLICE" > "$BASE/compose.host.yaml"
    rm -f "$HOST_SOCK"
    systemd-run --user --quiet --scope --slice="$HOST_SLICE" --unit=wardprofile-podman -- \
      podman system service --time=0 "unix://$HOST_SOCK" >>"$OUT/host-podman.log" 2>&1 &
    for _ in $(seq 100); do [ -S "$HOST_SOCK" ] && break; sleep 0.05; done
    [ -S "$HOST_SOCK" ] ;;
esac
