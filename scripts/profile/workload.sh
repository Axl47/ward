#!/usr/bin/env bash
# workload.sh warded|host: run the workload on all N copies at once. Each copy
# starts its Vite dev server (left running), brings Postgres up to healthy, then
# runs the pg test. Prints each copy's wall time and exits when all tests pass.
# Expects the engines to be up (start.sh) and leaves everything running.
source "$(dirname "$0")/lib.sh"
mode=$1

copy_warded() {
  cd "$WT/p$1"
  ward exec -- sh -c "nohup node_modules/.bin/vite > '$OUT/vite-warded-$1.log' 2>&1 &"
  ward exec -- docker compose up -d --wait --quiet-pull >/dev/null 2>&1
  ward exec -- node --test test/ >"$OUT/test-warded-$1.log" 2>&1
}

copy_host() {
  cd "$HOSTDIR/h$1"
  # Every process goes into the run's slice, so its cgroup counts them.
  local run=(env $(host_env "$1") systemd-run --user --quiet --scope --slice="$HOST_SLICE" --)
  "${run[@]}" sh -c "nohup node_modules/.bin/vite > '$OUT/vite-host-$1.log' 2>&1 &"
  "${run[@]}" docker compose -f compose.yaml -f "$BASE/compose.host.yaml" up -d --wait --quiet-pull >/dev/null 2>&1
  "${run[@]}" node --test test/ >"$OUT/test-host-$1.log" 2>&1
}

pids=()
for i in $(seq 1 "$N"); do
  ( a=$(now_us); "copy_$mode" "$i"; echo "copy $i: $(( ($(now_us) - a) / 1000 )) ms" ) &
  pids+=($!)
done
rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done
exit $rc
