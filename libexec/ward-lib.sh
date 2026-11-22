# Shared paths and worktree → ward resolution for Ward's shell entry points.
# src/paths.ts mirrors these rules; keep the two in sync.

WARD_HOME=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
WARD_LIBEXEC=$WARD_HOME/libexec
WARD_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/ward
WARD_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/ward
WARD_RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/ward
# The T3 home Ward serves. Deliberately not T3CODE_HOME: dev servers set that to
# their own state folder, and agents inherit it.
WARD_T3=${WARD_T3_HOME:-$HOME/.t3}
WARD_WORKTREES=$WARD_T3/worktrees
# Host loopback ports reachable from inside every ward: T3's server. DNS (53) is
# always forwarded too. Only a fallback: wardd writes each
# ward's list, with its project's ports, to $rt/host-ports.
WARD_HOST_PORTS=${WARD_HOST_PORTS:-3773}

# What could point a program on a ward's desktop at the live session instead:
# its display, its accessibility bus, and where it would look for the sound servers.
WARD_DESKTOP_UNSET="WAYLAND_DISPLAY WAYLAND_SOCKET DISPLAY UMBRIEL_SOCKET AT_SPI_BUS_ADDRESS PULSE_SERVER PULSE_RUNTIME_PATH PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE"

# Put this shell on the desktop ward_desktop_read checked last: its checked lines
# (_denv), not its `env` file, which is written inside the ward and could have
# changed since. Each line is exported verbatim, never run.
ward_desktop_env() {
  # shellcheck disable=SC2086
  unset $WARD_DESKTOP_UNSET
  while IFS= read -r _line; do
    [ -z "$_line" ] || export "$_line"
  done <<ENV
$_denv
ENV
}

# ID map for every ward's user namespace: your uid/gid stays itself (1000 → 1000),
# root and the other ids come from your subuid/subgid range.
ward_map_args() {
  _uid=$(id -u); _gid=$(id -g)
  _sub=$(awk -F: -v u="$(id -un)" '$1==u {print $2; exit}' /etc/subuid)
  _subg=$(awk -F: -v u="$(id -un)" '$1==u {print $2; exit}' /etc/subgid)
  [ -n "$_sub" ] && [ -n "$_subg" ] || { echo "ward: no /etc/subuid or /etc/subgid entry for $(id -un)" >&2; return 1; }
  # Inner 0..uid-1 and uid+1..65535 come from the 65536-id subordinate range.
  _after=$((65536 - _uid - 1))
  _gafter=$((65536 - _gid - 1))
  echo "--map-users=0:$_sub:$_uid --map-users=$_uid:$_uid:1 --map-users=$((_uid + 1)):$((_sub + _uid)):$_after" \
       "--map-groups=0:$_subg:$_gid --map-groups=$_gid:$_gid:1 --map-groups=$((_gid + 1)):$((_subg + _gid)):$_gafter"
}

# Sanitize one path segment into characters valid in a systemd instance name.
ward_sanitize() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_'
}

# ward_resolve DIR: set WARD_REPO, WARD_ROOT and WARD_ID when DIR is inside a T3
# worktree (<root>/<repo>/<name>/...), where <root> is the default worktrees folder
# or T3's worktreesDirectory setting when that is an absolute path. Returns 1 otherwise.
ward_resolve() {
  _dir=$1
  _wroot=$WARD_WORKTREES
  case "$_dir" in
    "$_wroot"/*/*) ;;
    /*/*/*)
      # Only folders outside the default pay for reading the setting.
      _wroot=$(sed -n 's/.*"worktreesDirectory"[[:space:]]*:[[:space:]]*"\(\/[^"]*\)".*/\1/p' "$WARD_T3/userdata/settings.json" 2>/dev/null)
      _wroot=${_wroot%/}
      case "$_dir" in
        "$_wroot"/*/*) [ -n "$_wroot" ] || return 1 ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
  _rest=${_dir#"$_wroot"/}
  WARD_REPO=${_rest%%/*}
  _rest=${_rest#*/}
  _name=${_rest%%/*}
  [ -n "$WARD_REPO" ] && [ -n "$_name" ] || return 1
  WARD_ROOT=$_wroot/$WARD_REPO/$_name
  WARD_ID=$(ward_sanitize "$WARD_REPO").$(ward_sanitize "$_name")
}

# The id of the desktop of T3 thread $1 where there is no ward (src/paths.ts: threadDesktopId).
ward_thread_desktop_id() {
  printf 't-%s' "$(ward_sanitize "$1")"
}

# ward_desktop_read ID UNIT [HOLDER]: whether desktop ID (a ward's, or a
# thread's) is up and its files are its own, setting _denv to its environment
# (the checked lines of its `env`) and _dcgroup to its unit's cgroup. Its folder
# is under the runtime folder every program of yours can write, so nothing there
# is taken on trust: `pid` must name a live process of UNIT (the ward's unit, or
# the thread desktop's own), `env` may hold only the names libexec/ward-desktop
# writes, all pointing into ID's own desktop folder through a short name d<digits>,
# and the sockets it names must be sockets of that folder, neither links nor hard
# links, which would reach another server: your live session's.
# A ward's desktop writes its pid as the ward's PID namespace sees it. From the
# host, HOLDER is the ward's namespace holder (`pid` in the ward's runtime folder,
# a host pid), and the desktop's pid is looked up in the ward's /proc through it,
# once HOLDER is shown to be a process of UNIT in another PID namespace than this
# one; inside the ward (no HOLDER), /proc is the ward's own.
ward_desktop_read() {
  _d=$WARD_RUNTIME/$1/desktop _denv= _dcgroup= _proc=/proc
  [ -d "$_d" ] && [ ! -L "$WARD_RUNTIME/$1" ] && [ ! -L "$_d" ] || return 1
  if [ -n "${3:-}" ]; then
    case $3 in *[!0-9]*) return 1 ;; esac
    { IFS= read -r _hcg < "/proc/$3/cgroup"; } 2>/dev/null || return 1
    case $_hcg in 0::/*/"$2") ;; *) return 1 ;; esac
    [ ! "/proc/$3/ns/pid" -ef "/proc/$$/ns/pid" ] || return 1
    _proc=/proc/$3/root/proc
  fi
  { IFS= read -r _dpid < "$_d/pid"; } 2>/dev/null || return 1
  case $_dpid in '' | *[!0-9]*) return 1 ;; esac
  { IFS= read -r _dcgroup < "$_proc/$_dpid/cgroup"; } 2>/dev/null || return 1
  case $_dcgroup in 0::/*/"$2") _dcgroup=/sys/fs/cgroup${_dcgroup#0::} ;; *) return 1 ;; esac
  _xrd= _wd= _us= _bus= _tmp= _cfg=
  while IFS= read -r _line || [ -n "$_line" ]; do
    _v=${_line#*=}
    case $_line in
      XDG_RUNTIME_DIR=*) _xrd=$_v ;;
      WAYLAND_DISPLAY=*) _wd=$_v ;;
      UMBRIEL_SOCKET=*) _us=$_v ;;
      DBUS_SESSION_BUS_ADDRESS=*) _bus=$_v ;;
      TMPDIR=*) _tmp=$_v ;;
      XDG_CONFIG_HOME=*) _cfg=$_v ;;
      XDG_CURRENT_DESKTOP=* | XDG_SESSION_DESKTOP=* | XDG_SESSION_TYPE=*) case $_v in *[!A-Za-z0-9:_-]*) return 1 ;; esac ;;
      DISPLAY=) ;;
      *) return 1 ;;
    esac
    _denv="$_denv$_line
"
  done < "$_d/env" 2>/dev/null || return 1
  case $_wd in wayland-[0-9]*) case $_wd in *[!a-z0-9-]*) return 1 ;; esac ;; *) return 1 ;; esac
  case ${_xrd##*/} in d | d*[!0-9]*) return 1 ;; d*) ;; *) return 1 ;; esac
  [ "$_xrd" -ef "$_d" ] || return 1
  [ "$_us" = "$_xrd/umbriel-$_wd.sock" ] && [ "$_bus" = "unix:path=$_xrd/bus" ] || return 1
  [ -z "$_tmp" ] || [ "$_tmp" = "$_xrd/tmp" ] || return 1
  [ -z "$_cfg" ] || [ "$_cfg" = "$_xrd/tmp/desktop/config" ] || return 1
  for _s in "$_xrd/$_wd" "$_us" "$_xrd/bus"; do
    [ -S "$_s" ] && [ ! -L "$_s" ] || return 1
  done
  [ "$(stat -c %h -- "$_xrd/$_wd" "$_us" "$_xrd/bus" 2>/dev/null)" = "1
1
1" ]
}

ward_enabled() {
  [ -e "$WARD_CONFIG/enabled/$1" ]
}
