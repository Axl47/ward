# A ward's runtime folders: what of yours they show, and keeping them in step with
# yours. Sourced (bash) by ward-init, which makes the shared entries, by
# ward-init-root, which makes the view (runtime_view) and runs the watcher
# (watch_runtime), and by test/runtime-entry.test.ts and test/runtime-view.sh.

# ward_runtime_shared UID: sets _shared to the entries of your runtime folder (UID:
# yours) that wards share writable with the host and each other, folders ending in /.
# ward-init makes them first if missing, since a ward that made its own would take
# locks nobody else sees: pnpm's for the store every ward shares (pnpm 12), Caliban's
# for its model jobs, and the lock every Puck acting on the live session takes.
ward_runtime_shared() {
  _shared="pnpm-dir-locks-$1/ pnpm-metadata-mutation-locks-$1/ pnpm-store-operation-locks-$1/ pnpm-verify-deps-install-locks-$1/ caliban/ puck.lock"
}

# ward_runtime_entry NAME UID: whether a ward sees NAME, an entry of your runtime
# folder, setting _rwe to how: ro (read-only) or rw (shared, ward_runtime_shared),
# with a trailing / when it must be a folder (and must not be one otherwise).
# Everything else there is absent from a ward, which has a runtime folder of its own
# (runtime_view): Claude Code's cc-socks, gpg-agent, the keyring's own sockets,
# Podman's and systemd's, Ariel's, the shell's IPC.
# Read-only: your live session (wayland-N, umbriel-wayland-N.sock), for GUI apps run
# in a ward, Miranda's worktrees and PUCK_DESKTOP=live (docs/DESIGN.md, Risks), and
# sound played through it (pipewire-0, pulse).
ward_runtime_entry() {
  local a n
  _rwe=ro
  case $1 in
    pipewire-0) return 0 ;;
    pulse) _rwe=ro/; return 0 ;;
    wayland-[0-9]*) case ${1#wayland-} in *[!0-9]*) return 1 ;; esac; return 0 ;;
    umbriel-wayland-[0-9]*.sock) n=${1#umbriel-wayland-}; case ${n%.sock} in *[!0-9]*) return 1 ;; esac; return 0 ;;
  esac
  ward_runtime_shared "$2"
  for a in $_shared; do
    [ "$1" = "${a%/}" ] || continue
    _rwe=rw${a#"${a%/}"}
    return 0
  done
  return 1
}

# The ward's runtime folders, outer first, and for each an fd on yours, which only
# the watcher keeps: its processes are outside the ward's PID namespace.
view_dirs=() view_fds=()
declare -A shown=()   # each entry sync_runtime shows: its path in the view → yours
declare -A refused=() # listed entries it won't show (a hard link, a failed mount) → their device:inode

# runtime_view RT: each runtime folder (/run/user/<uid>, and XDG_RUNTIME_DIR if it is
# another) becomes a memory folder of the ward's own, shared (mount propagation), so
# the watcher's mounts here reach the ward's namespace. In it: the entries
# ward_runtime_entry lists, Ward's own folder (lock_down narrows it further) and,
# read-only as `bus`, the ward's bus proxy in RT, the ward's folder of Ward's.
runtime_view() {
  local rt=$1 d i fd ward_parent x=${XDG_RUNTIME_DIR%/}
  # Through a link, the view would go over the link's target, and the ward's
  # programs would still look up the link, in a folder it doesn't cover.
  if [ -n "$x" ] && [ "$(readlink -f -- "$x")" != "$x" ]; then
    echo "ward: XDG_RUNTIME_DIR ($x) is not the folder's own path (a link, or . or .. in it); set it to that" >&2
    return 1
  fi
  # Missing, it would appear unfiltered in the ward once you log in.
  [ -d "/run/user/$WARD_HOST_UID" ] || {
    echo "ward: /run/user/$WARD_HOST_UID is missing; wards need your systemd user session" >&2
    return 1
  }
  mount_api_check || return
  command -v "${WARD_NODE:-node}" >/dev/null || { echo "ward: node not found (set WARD_NODE)" >&2; return 1; }
  for d in "/run/user/$WARD_HOST_UID" "$x"; do
    [ -n "$d" ] && [ -d "$d" ] || continue
    d=$(readlink -f -- "$d")
    [[ " ${view_dirs[*]} " == *" $d "* ]] || view_dirs+=("$d")
  done
  [ "${#view_dirs[@]}" -lt 2 ] || [ "${#view_dirs[0]}" -le "${#view_dirs[1]}" ] || view_dirs=("${view_dirs[1]}" "${view_dirs[0]}")
  ward_parent=$(dirname -- "$(readlink -f -- "$WARD_RUNTIME")")
  # Called where `set -e` doesn't apply, so each step that must work says so.
  for i in "${!view_dirs[@]}"; do exec {fd}<"${view_dirs[$i]}" || return; view_fds[i]=$fd; done
  for i in "${!view_dirs[@]}"; do
    d=${view_dirs[$i]} fd=${view_fds[$i]}
    # An inner one (a second Ward's XDG_RUNTIME_DIR) is gone from the outer's view.
    mkdir -p -- "$d" &&
      mount -t tmpfs -o mode=0700,size=10%,nosuid,nodev tmpfs "$d" &&
      chown --reference="/proc/self/fd/$fd" -- "$d" &&
      mount --make-shared "$d" || return
    if [ "$d" = "$ward_parent" ]; then
      mkdir -- "$d/ward" && mount --no-canonicalize --bind "/proc/self/fd/$fd/ward" "$d/ward" || return
    fi
  done
  sync_runtime
  [ -S "$rt/bus" ] || return 0
  for d in "${view_dirs[@]}"; do
    : >"$d/bus" && mount --bind -o ro "$rt/bus" "$d/bus" || {
      rm -f -- "$d/bus"
      echo "ward: warning: could not show the session bus proxy at $d/bus; the ward has no session bus" >&2
    }
  done
}

# mount_api_check: whether mount here makes a bind read-only before attaching it, as
# sync_runtime needs: util-linux 2.39+ built with the kernel's newer mount API
# (fd-based-mount), on Linux 5.14+, below which libmount falls back to a bind and then
# a remount, whatever LIBMOUNT_FORCE_MOUNT2 says.
mount_api_check() {
  local k u v
  IFS=. read -r k u _ </proc/sys/kernel/osrelease
  v=$(mount --version)
  if (( k > 5 || (k == 5 && ${u%%[!0-9]*} >= 14) )) && [[ $v == *fd-based-mount* ]] &&
    [[ $v =~ util-linux\ ([0-9]+)\.([0-9]+) ]] &&
    (( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 39) )); then
    return 0
  fi
  echo "ward: wards need Linux 5.14+ and util-linux 2.39+ with fd-based-mount ($(uname -r); $v), or what they see of your runtime folder could be writable" >&2
  return 1
}

# listed ENTRY: whether ENTRY, a path to an entry of your runtime folder, is one to
# show: listed (ward_runtime_entry, setting _rwe), there, of the kind listed, and not a link.
listed() {
  ward_runtime_entry "${1##*/}" "$WARD_HOST_UID" && [ ! -L "$1" ] || return
  case $_rwe in */) [ -d "$1" ] ;; *) [ -e "$1" ] && [ ! -d "$1" ] ;; esac
}

# sync_runtime: shows each listed entry of your runtime folders in the ward's, once
# it is there, of the kind listed, and neither a link nor a hard link (which could be
# one an older ward made to a socket off the list); shows the new one when one is
# replaced, and takes one away when it is gone. An entry the ward made first is left
# to it. The view is the ward's to write, so whatever the ward puts at a name before
# the watcher's placeholder or mount can only change that ward's view, or land out of
# its sight: placeholders are made by mkdir, or mktemp and ln, which neither open nor
# follow what is there, the mount doesn't follow a link at its target's last
# component, and unshow's unmount doesn't follow one either.
sync_runtime() {
  local i src dst e n v h
  for i in "${!view_dirs[@]}"; do
    src=/proc/self/fd/${view_fds[$i]} dst=${view_dirs[$i]}
    for e in "$src"/*; do
      n=${e##*/}
      listed "$e" || continue
      v=$dst/$n
      # A refused entry is tried again once it is another file (replaced, say by rename).
      if [ -n "${refused[$v]:-}" ]; then
        [ "$(stat -c %d:%i -- "$e" 2>/dev/null)" != "${refused[$v]}" ] || continue
        unset 'refused[$v]'
      fi
      if [ -n "${shown[$v]:-}" ]; then
        [ ! "$v" -ef "$e" ] || continue
        unshow "$v" || continue
        [ ! -e "$v" ] && [ ! -L "$v" ] || continue
      elif [ -e "$v" ] || [ -L "$v" ]; then
        continue
      fi
      # Its identity before the mount, so a refusal holds only for this file.
      h=$(stat -c '%h %d:%i' -- "$e" 2>/dev/null) || continue
      [ -d "$e" ] || [ "${h%% *}" = 1 ] || { refused[$v]=${h#* }; continue; }
      if [ -d "$e" ]; then mkdir -- "$v"; else placeholder "$v"; fi || continue
      # Read-only as it is made: libmount's newer mount API (mount_api_check; forced
      # here so it never falls back to mount(2) by choice) sets it on the new mount
      # before attaching it, where a bind and then a remount would leave the ward's
      # copy writable, the remount not propagating.
      LIBMOUNT_FORCE_MOUNT2=never mount --no-canonicalize --bind -o "${_rwe%/}" "$e" "$v" || {
        refused[$v]=${h#* }
        rm -f -- "$v" 2>/dev/null || rmdir -- "$v"
        continue
      }
      shown[$v]=$e
    done
  done
  for v in "${!shown[@]}"; do
    listed "${shown[$v]}" || unshow "$v"
  done
  return 0
}

# placeholder PATH: makes PATH an empty file, as long as nothing is there yet (a link
# would be followed by `: >`, and a FIFO opened, which hangs).
placeholder() {
  local t
  t=$(mktemp -p "${1%/*}" .ward-XXXXXX) || return
  ln -- "$t" "$1"
  set -- $? "$t"
  rm -f -- "$2"
  return "$1"
}

# unshow PATH: takes away what sync_runtime shows at PATH (lazily, should a process be
# in it), then its placeholder, never recursively: it covered a folder of yours.
# Removing the placeholder is what takes the entry from the ward's copy, which the
# kernel locked and so skips when propagating the unmount. A PATH no longer mounted
# (its placeholder removed in the ward, and maybe something of the ward's there
# since, a link even) is simply forgotten.
unshow() {
  if "${WARD_NODE:-node}" --disable-warning=ExperimentalWarning "$WARD_HOME/src/detach.ts" "$1" 2>/dev/null; then
    rm -f -- "$1" 2>/dev/null || rmdir -- "$1" 2>/dev/null || :
  elif [ ! -L "$1" ] && mountpoint -q -- "$1"; then
    return 1
  fi
  unset 'shown[$1]'
}

# watch_runtime: runs sync_runtime every second for as long as the ward runs (the
# unit's stop kills it), starting no process unless something changed or an entry
# is refused.
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
