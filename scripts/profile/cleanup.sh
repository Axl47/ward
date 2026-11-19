#!/usr/bin/env bash
# cleanup.sh: undo setup.sh and measure.sh: stop both modes, remove the profile
# wards and their data, disable wards for ward-profile, delete postgres:17 from
# both image stores, and delete the fixture, its worktrees and the results.
source "$(dirname "$0")/lib.sh"
"$HERE/stop.sh" host
"$HERE/stop.sh" warded
for i in $(seq 0 "$N"); do ward rm --now "$(ward_id "p$i")" 2>/dev/null || true; done
ward disable ward-profile
ward images rmi docker.io/library/postgres:17 2>/dev/null || true
podman rmi docker.io/library/postgres:17 2>/dev/null || true
rm -rf "$WT" "$BASE"
