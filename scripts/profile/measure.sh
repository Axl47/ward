#!/usr/bin/env bash
# measure.sh PHASE...: run measurements after setup.sh; raw results land in $OUT.
#   workload  5 runs per mode: CPU over the active workload, steady and peak memory
#   ports     dev server latency/throughput: inside the ward, mapped host port, unwarded
#   disk      per-copy disk use while the workload is up (run right after `ports`)
#   idle      one idle ward's memory; wardd's memory and CPU over 60 s with N wards up
#   startup   ward up, first and warm ward exec, compose up to healthy
#   wardd     wardd's CPU over 60 s with no profile ward up, then with N empty ones
# Phases leave the copies running for the next one; `stop.sh MODE` cleans up.
source "$(dirname "$0")/lib.sh"
RUNS=${RUNS:-5}
SETTLE=${SETTLE:-20}   # seconds after the workload before steady-state sampling, and its length

# One workload run in MODE: fresh engines, sampler on the copies' cgroups.
workload_run() {
  local mode=$1 k=$2 cgs=() sampler a
  # Only this mode's copies run, so the other mode's idle copies don't add load.
  "$HERE/stop.sh" host; "$HERE/stop.sh" warded
  "$HERE/start.sh" "$mode"
  if [ "$mode" = warded ]; then
    for i in $(seq 1 "$N"); do cgs+=("p$i=$(ward_cg "p$i")"); done
    cgs+=("wards-slice=$WARDS_CG")
  else
    cgs+=("host-slice=$HOST_CG")
  fi
  node "$HERE/sampler.ts" "${cgs[@]}" >"$OUT/workload-$mode-$k.jsonl" &
  sampler=$!
  sleep 0.5
  { load; a=$(now_us); "$HERE/workload.sh" "$mode"; echo "wall: $(( ($(now_us) - a) / 1000 )) ms"; load; } >"$OUT/workload-$mode-$k.txt"
  kill -USR1 "$sampler"
  sleep "$SETTLE"; kill -USR2 "$sampler"
  sleep "$SETTLE"; kill -TERM "$sampler"; wait "$sampler"
}

phase_workload() {
  for k in $(seq 1 "$RUNS"); do
    for mode in host warded; do echo "workload $mode run $k"; workload_run "$mode" "$k"; done
  done
}

# Needs both modes up: the last workload run leaves warded up; start host too.
phase_ports() {
  if [ ! -S "$HOST_SOCK" ]; then "$HERE/start.sh" host; "$HERE/workload.sh" host; fi
  local hp; hp=$(cd "$WT/p1" && ward port 5173)
  {
    load
    for k in $(seq 1 "$RUNS"); do
      # Vite binds localhost, which is ::1 here; wardd's host ports bind 127.0.0.1.
      echo "inside $(cd "$WT/p1" && ward exec -- node "$HERE/bench.ts" "http://[::1]:5173")"
      local c0 b0; c0=$(cpu_usec "$WARDD_CG"); b0=$(cpu_usec "$(ward_cg p1)")
      echo "mapped $(node "$HERE/bench.ts" "http://127.0.0.1:$hp")"
      echo "mapped-cpu wardd $(( $(cpu_usec "$WARDD_CG") - c0 )) ward-p1 $(( $(cpu_usec "$(ward_cg p1)") - b0 )) usec"
      c0=$(cpu_usec "$HOST_CG")
      echo "direct $(node "$HERE/bench.ts" "http://[::1]:$(host_vite_port 1)")"
      echo "direct-cpu host-slice $(( $(cpu_usec "$HOST_CG") - c0 )) usec"
    done
    load
  } | tee "$OUT/ports.txt"
}

# KiB used under a ward's state folder, read as root of its user namespace
# (container files belong to subordinate uids).
ward_du() { nsenter -U -t "$(cat "$XDG_RUNTIME_DIR/ward/$(ward_id "$1")/pid")" -- du -sx "$2" | cut -f1; }

phase_disk() {
  {
    for i in $(seq 1 "$N"); do
      local st=$HOME/.local/state/ward/wards/$(ward_id "p$i")
      echo "warded p$i: state $(ward_du "p$i" "$st") storage $(ward_du "p$i" "$st/storage") tmp $(ward_du "p$i" "$st/tmp") home $(ward_du "p$i" "$st/home") KiB"
    done
    for i in $(seq 1 "$N"); do
      local vol cid
      vol=$(podman volume inspect "wp-host-${i}_pgdata" --format '{{.Mountpoint}}')
      cid=$(podman ps -q --filter "label=com.docker.compose.project=wp-host-$i")
      echo "host h$i: volume $(podman unshare du -sx "$vol" | cut -f1) KiB, container $(podman container inspect --size "$cid" --format '{{.SizeRw}}') B"
    done
    echo "shared ward image store: $(podman unshare du -sx "$HOME/.local/state/ward/images" | cut -f1) KiB"
    echo "host image store: $(podman unshare du -sx "$HOME/.local/share/containers/storage" | cut -f1) KiB (includes the run's volumes)"
  } | tee "$OUT/disk.txt"
}

phase_idle() {
  ward up --worktree "$WT/p0" --quiet
  sleep 10
  local cg; cg=$(ward_cg p0)
  {
    load
    echo "idle ward p0: current $(cat "$cg/memory.current") peak $(cat "$cg/memory.peak") B"
    ps -o pid=,rss=,comm= -p "$(cat "$cg/cgroup.procs" | paste -sd,)"
    local c0 c1; c0=$(cpu_usec "$cg"); sleep 60; c1=$(cpu_usec "$cg")
    echo "idle ward p0 cpu over 60 s: $((c1 - c0)) usec"
    echo "wardd: current $(cat "$WARDD_CG/memory.current") B"
    echo "wards up: $(ward ls | grep -c '●')"
    for k in $(seq 1 "$RUNS"); do
      c0=$(cpu_usec "$WARDD_CG"); sleep 60; c1=$(cpu_usec "$WARDD_CG")
      echo "wardd cpu over 60 s: $((c1 - c0)) usec"
    done
    load
  } | tee "$OUT/idle.txt"
}

phase_startup() {
  local id0; id0=$(ward_id p0)
  {
    load
    echo "## ward up, cold (ward stopped, data kept)"
    for k in $(seq 1 "$RUNS"); do ward stop "$id0" >/dev/null 2>&1 || true; time_ms ward up --worktree "$WT/p0" --quiet; done | stats "ward up cold (ms)"
    echo "## first ward exec in a fresh worktree"
    for k in $(seq 1 "$RUNS"); do
      git -C "$REPO" worktree add -q --detach "$WT/fresh$k"
      time_ms ward exec --worktree "$WT/fresh$k" -- true
      ward rm --now "$(ward_id "fresh$k")" >/dev/null
      git -C "$REPO" worktree remove --force "$WT/fresh$k"
    done | stats "first ward exec (ms)"
    echo "## warm ward exec vs bare true (200 runs each)"
    cd "$WT/p0"
    for k in $(seq 200); do time_ms ward exec -- true; done | stats "warm ward exec -- true (ms)"
    for k in $(seq 200); do time_ms true; done | stats "bare true (ms)"
    for k in $(seq 200); do time_ms /usr/bin/true; done | stats "bare /usr/bin/true (ms)"
    echo "## docker compose up -d --wait to healthy (copy 1, volume removed between runs)"
    cd "$WT/p1"
    for k in $(seq 1 "$RUNS"); do
      ward exec -- docker compose down -v >/dev/null 2>&1
      time_ms ward exec -- docker compose up -d --wait
    done | stats "warded compose up (ms)"
    cd "$HOSTDIR/h1"
    for k in $(seq 1 "$RUNS"); do
      env $(host_env 1) docker compose down -v >/dev/null 2>&1
      time_ms env $(host_env 1) docker compose -f compose.yaml -f "$BASE/compose.host.yaml" up -d --wait
    done | stats "host compose up (ms)"
    load
  } | tee "$OUT/startup.txt"
}

wardd_cpu() {
  for k in 1 2 3; do
    local c0; c0=$(cpu_usec "$WARDD_CG"); sleep 60
    echo "wardd cpu over 60 s: $(( $(cpu_usec "$WARDD_CG") - c0 )) usec (wards up: $(ward ls | grep -c '●'))"
  done
}

phase_wardd() {
  "$HERE/stop.sh" host; "$HERE/stop.sh" warded
  ward stop "$(ward_id p0)" >/dev/null 2>&1 || true
  {
    load
    echo "## no profile ward up (other wards may be)"; wardd_cpu
    "$HERE/start.sh" warded; sleep 5
    echo "## $N empty profile wards up"; wardd_cpu
    load
  } | tee "$OUT/wardd.txt"
  "$HERE/stop.sh" warded
}

for phase in "$@"; do "phase_$phase"; done
