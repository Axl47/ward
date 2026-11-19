#!/usr/bin/env bash
# stop.sh warded|host: remove the copies' containers and volumes, then stop
# everything else (dev servers, engines). Safe to run when nothing is up.
source "$(dirname "$0")/lib.sh"
case $1 in
  warded)
    for i in $(seq 1 "$N"); do
      if ward ls | grep -q "● $(ward_id "p$i")"; then
        (cd "$WT/p$i" && ward exec -- docker compose down -v >/dev/null 2>&1) || true
        ward stop "$(ward_id "p$i")" >/dev/null
      fi
    done ;;
  host)
    if [ -S "$HOST_SOCK" ]; then
      for i in $(seq 1 "$N"); do
        (cd "$HOSTDIR/h$i" && env $(host_env "$i") docker compose down -v >/dev/null 2>&1) || true
      done
    fi
    # Stopping the slice kills the Podman service and dev servers and removes it.
    systemctl --user stop "$HOST_SLICE" 2>/dev/null || true
    rm -f "$HOST_SOCK" ;;
esac
