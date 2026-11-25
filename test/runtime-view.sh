#!/bin/bash
# Run by test/runtime-view.test.ts as root of a user namespace (unshare -Urm):
# runtime-view.sh LIBEXEC DIR. DIR/real stands in for your runtime folder, DIR/view
# for the ward's; a namespace copied from it one user namespace further in, as the
# ward's is, reports what it sees. Each line: what the ward's copy shows at a step.
set -euo pipefail
. "$1/ward-lib.sh"
. "$1/ward-runtime.sh"
WARD_HOST_UID=1000 R=$2/real V=$2/view
mkdir -p "$R/cc-socks" "$R/pulse" "$V"
echo old >"$R/wayland-0"; echo s >"$R/cc-socks/1.sock"; echo k >"$R/keyring"
mount -t tmpfs tmpfs "$V"
mount --make-shared "$V"
exec {fd}<"$R"
view_dirs=("$V") view_fds=("$fd")
sync_runtime

# The ward's copy: each line read is run there, then __end__ marks its output's end.
coproc WARD { exec unshare -U -r -m --propagation unchanged bash -c 'while IFS= read -r c; do eval "$c"; echo __end__; done' 2>&1; }
ask() {
  local l
  echo "$1" >&"${WARD[1]}"
  while IFS= read -r l <&"${WARD[0]}" && [ "$l" != __end__ ]; do echo "$l"; done
}
# see: each entry of the view with its mount's first option (ro or rw).
ask "see() { for f in $V/*; do printf '%s:%s ' \"\${f##*/}\" \"\$(awk -v m=\"\$f\" '\$5 == m { o = \$6 } END { print substr(o, 1, 2) }' /proc/self/mountinfo)\"; done; echo; }"

echo "start $(ask see)"
echo "content $(ask "cat $V/wayland-0")"
echo late >"$R/wayland-2"; ln "$R/keyring" "$R/wayland-3"; mkdir "$R/caliban"
sync_runtime
echo "late $(ask see)"
echo "remount $(ask "mount -o remount,bind,rw $V/wayland-2 2>/dev/null && echo rw || echo refused")"
rm "$R/wayland-0" "$R/wayland-2"; echo new >"$R/wayland-0"
sync_runtime
echo "after $(ask see)"
echo "content $(ask "cat $V/wayland-0")"
