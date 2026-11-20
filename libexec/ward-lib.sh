# Shared paths and worktree → ward resolution for Ward's shell entry points.
# src/paths.ts mirrors these rules; keep the two in sync.

WARD_HOME=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
WARD_LIBEXEC=$WARD_HOME/libexec
WARD_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/ward
WARD_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/ward
WARD_RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/ward
# The T3 home Ward serves. Deliberately not T3CODE_HOME: dev servers set that to
# their own state folder, and agents inherit it.
WARD_WORKTREES=${WARD_T3_HOME:-$HOME/.t3}/worktrees
# Host loopback ports reachable from inside every ward: T3's server and the adb
# server. DNS (53) is always forwarded too. Only a fallback: wardd writes each
# ward's list, with its project's ports, to $rt/host-ports.
WARD_HOST_PORTS=${WARD_HOST_PORTS:-3773,5037}

# What could point a program on a ward's desktop at the live session instead:
# its display, its accessibility bus, and where it would look for the sound servers.
WARD_DESKTOP_UNSET="WAYLAND_DISPLAY WAYLAND_SOCKET DISPLAY UMBRIEL_SOCKET AT_SPI_BUS_ADDRESS PULSE_SERVER PULSE_RUNTIME_PATH PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE"

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
# worktree (<worktrees>/<repo>/<name>/...). Returns 1 otherwise.
ward_resolve() {
  _dir=$1
  case "$_dir" in
    "$WARD_WORKTREES"/*/*) ;;
    *) return 1 ;;
  esac
  _rest=${_dir#"$WARD_WORKTREES"/}
  WARD_REPO=${_rest%%/*}
  _rest=${_rest#*/}
  _name=${_rest%%/*}
  [ -n "$WARD_REPO" ] && [ -n "$_name" ] || return 1
  WARD_ROOT=$WARD_WORKTREES/$WARD_REPO/$_name
  WARD_ID=$(ward_sanitize "$WARD_REPO").$(ward_sanitize "$_name")
}

ward_enabled() {
  [ -e "$WARD_CONFIG/enabled/$1" ]
}
