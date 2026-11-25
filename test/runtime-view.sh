#!/bin/bash
# Run by test/runtime-view.test.ts as root of a user namespace (unshare -Urm):
# runtime-view.sh LIBEXEC. A memory folder over /run stands in for yours, with
# XDG_RUNTIME_DIR two levels inside /run/user/<uid>, as a second Ward's is; then
# runtime_view makes the ward's view, and a namespace copied from it one user
# namespace further in, as the ward's is, reports what it sees. Each line: what the
# ward's copy shows at a step.
set -euo pipefail
. "$1/ward-runtime.sh"
mount -t tmpfs tmpfs /run
WARD_HOST_UID=4242 U=/run/user/4242
export XDG_RUNTIME_DIR=$U/w/x
WARD_RUNTIME=$XDG_RUNTIME_DIR/ward rt=$XDG_RUNTIME_DIR/ward/t
mkdir -p "$U/cc-socks" "$U/pulse" "$rt"
echo old >"$U/wayland-0"; echo s >"$U/cc-socks/1.sock"; echo k >"$U/keyring"
python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$rt/bus"
ln -s "$XDG_RUNTIME_DIR" /run/x
echo "link $( (XDG_RUNTIME_DIR=/run/x runtime_view "$rt") 2>/dev/null && echo shown || echo refused)"
runtime_view "$rt"
R=/proc/self/fd/${view_fds[0]} # yours, under the view

# The ward's copy: each line read is run there, then __end__ marks its output's end.
coproc WARD { exec unshare -U -r -m --propagation unchanged bash -c 'while IFS= read -r c; do eval "$c"; echo __end__; done' 2>&1; }
ask() {
  local l
  echo "$1" >&"${WARD[1]}"
  while IFS= read -r l <&"${WARD[0]}" && [ "$l" != __end__ ]; do echo "$l"; done
}
# see DIR: each entry of DIR with its mount's first option (ro or rw, none if not one).
ask "see() { for f in \$1/*; do printf '%s:%s ' \"\${f##*/}\" \"\$(awk -v m=\"\$f\" '\$5 == m { o = \$6 } END { print substr(o, 1, 2) }' /proc/self/mountinfo)\"; done; echo; }"

echo "start $(ask "see $U")"
echo "inner $(ask "see $XDG_RUNTIME_DIR; ls $WARD_RUNTIME")"
echo "content $(ask "cat $U/wayland-0")"
# wayland-3, a hard link, puck.lock, a folder, and keyring, off the list, stay out.
echo late >"$R/wayland-2"; ln "$R/keyring" "$R/wayland-3"; mkdir "$R/caliban" "$R/puck.lock"
sync_runtime
echo "late $(ask "see $U")"
echo "remount $(ask "mount -o remount,bind,rw $U/wayland-2 2>/dev/null && echo rw || echo refused")"
# wayland-3 replaced by a file of its own is shown; wayland-2 replaced by a folder goes.
rm "$R/wayland-0" "$R/wayland-2"; mkdir "$R/wayland-2"; echo new >"$R/wayland-0"; echo n >"$R/n"; mv "$R/n" "$R/wayland-3"
sync_runtime
echo "after $(ask "see $U")"
echo "content $(ask "cat $U/wayland-0")"
