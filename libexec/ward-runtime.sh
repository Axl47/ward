# The ward's view of your runtime folders, kept in step with them. Sourced by
# ward-init-root (bash), whose runtime_view sets view_dirs and view_fds and makes each
# view a shared mount, and by test/runtime-view.test.ts. Needs ward-lib.sh and
# WARD_HOST_UID.

# The ward's runtime folders, outer first, and for each an fd on yours, which only
# the watcher keeps: its processes are outside the ward's PID namespace.
view_dirs=() view_fds=()
declare -A shown=()   # each entry sync_runtime shows: its path in the view → yours
declare -A refused=() # listed entries it won't show (a hard link, a failed mount), until they go

# sync_runtime: shows each listed entry of your runtime folders in the ward's, once
# it is there and is neither a link nor a hard link (which could be one an older
# ward made to a socket off the list); shows the new one when one is replaced, and
# takes one away when it is gone. An entry the ward made first is left to it. The
# view is the ward's to write, so whatever the ward puts at a name before the
# watcher's placeholder or mount (noclobber refuses a link to a missing file, not
# one to a FIFO, which would hang the watcher) can only change that ward's view, or
# land out of its sight.
sync_runtime() {
  local - i src dst e n v
  set -C
  for i in "${!view_dirs[@]}"; do
    src=/proc/self/fd/${view_fds[$i]} dst=${view_dirs[$i]}
    for e in "$src"/*; do
      n=${e##*/}
      ward_runtime_entry "$n" "$WARD_HOST_UID" && [ ! -L "$e" ] && [ -e "$e" ] || continue
      v=$dst/$n
      [ -z "${refused[$v]:-}" ] || continue
      if [ -n "${shown[$v]:-}" ]; then
        [ ! "$v" -ef "$e" ] || continue
        unshow "$v" || continue
        [ ! -e "$v" ] || continue
      elif [ -e "$v" ] || [ -L "$v" ]; then
        continue
      fi
      [ -d "$e" ] || [ "$(stat -c %h -- "$e")" = 1 ] || { refused[$v]=$e; continue; }
      if [ -d "$e" ]; then mkdir -- "$v"; else : >"$v"; fi || continue
      # Read-only as it is made (libmount sets it on the new mount before attaching
      # it): a bind and then a remount would leave the ward's copy writable.
      mount --no-canonicalize --bind -o "$_rwe" "$e" "$v" || {
        refused[$v]=$e
        rm -f -- "$v" 2>/dev/null || rmdir -- "$v"
        continue
      }
      shown[$v]=$e
    done
  done
  for v in "${!shown[@]}"; do
    e=${shown[$v]}
    [ -e "$e" ] && [ ! -L "$e" ] || unshow "$v"
  done
  for v in "${!refused[@]}"; do
    e=${refused[$v]}
    [ -e "$e" ] && [ ! -L "$e" ] || unset 'refused[$v]'
  done
  return 0
}

# unshow PATH: takes away what sync_runtime shows at PATH (lazily, should a process be
# in it), then its placeholder, never recursively: it covered a folder of yours.
# Removing the placeholder is what takes the entry from the ward's copy, which the
# kernel locked and so skips when propagating the unmount. A PATH no longer mounted
# (its placeholder removed in the ward) is simply forgotten.
unshow() {
  umount -l -- "$1" 2>/dev/null || ! mountpoint -q -- "$1" || return
  unset 'shown[$1]'
  rm -f -- "$1" 2>/dev/null || rmdir -- "$1" 2>/dev/null || :
}

# watch_runtime: runs sync_runtime every second for as long as the ward runs (the
# unit's stop kills it), with no process started unless something changed.
watch_runtime() {
  local tick
  set +eu
  trap 'echo "ward: warning: the runtime folder watcher stopped; sockets of yours made or replaced from now on stay out of the ward" >&2' EXIT
  trap 'trap - EXIT; exit 0' TERM # the ward stopping
  exec {tick}<> <(:)
  while :; do
    read -rt 1 -u "$tick"
    sync_runtime 2>/dev/null
  done
}
