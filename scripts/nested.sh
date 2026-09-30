#!/usr/bin/env bash
#
# Runs this extension in a throwaway GNOME Shell, so that it can be seen
# without logging out of the one you are using.
#
#   ./scripts/dev.sh nested            headless: load it, say what it built, stop
#   ./scripts/dev.sh nested --window   a nested shell in a window, to look at
#   ./scripts/dev.sh nested --keep     headless, but left running
#
# Why this exists: a UUID the running shell has never seen cannot be enabled in
# a Wayland session, so the first run of a new extension otherwise costs a log
# out and back in. This starts a second shell instead, which has never seen
# anything, and enables it there.
#
# Nothing of the live session is written. The throwaway shell gets:
#
#   * its own D-Bus session, from dbus-launch;
#   * its own settings, through the keyfile GSettings backend under a scratch
#     XDG_CONFIG_HOME -- so dconf, and with it every setting of the desktop you
#     are actually using, is never opened, let alone written;
#   * only this extension enabled, so anything that goes wrong is ours.
#
# It reads the extension from where an install put it, which means `link` or
# `install` first. `link` is the one to want: its entry point turns the
# logging up, and the lines below are then worth reading.

set -uo pipefail

UUID="ai-usage@jackicus"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/ai-usage-nested"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

mode="headless"
keep="no"
for arg in "$@"; do
    case "$arg" in
        --window)  mode="window" ;;
        --keep)    keep="yes" ;;
        *)         die "Unknown option '$arg'. Try --window or --keep." ;;
    esac
done

command -v gnome-shell >/dev/null || die "'gnome-shell' not found in PATH."
command -v dbus-launch >/dev/null || die "'dbus-launch' not found in PATH (install dbus)."
[[ -e "$EXT_DIR" || -L "$EXT_DIR" ]] || die "Nothing installed at $EXT_DIR. Run 'make link' first."

# A nested shell is a client of the one you are in; headless needs nobody.
if [[ "$mode" == "window" && -z "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
    die "--window needs a session to open a window in; use the headless mode instead."
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/config/glib-2.0/settings"

# The whole configuration of the throwaway shell, in one file it is the only
# reader of. Anything not named here is that setting's default.
cat > "$RUN_DIR/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='99.0'
EOF

cleanup() {
    [[ -n "${SHELL_PID:-}" ]] && kill "$SHELL_PID" 2>/dev/null
    [[ -n "${DBUS_SESSION_BUS_PID:-}" ]] && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null
    return 0
}
trap cleanup EXIT INT TERM

# From here on the environment belongs to the throwaway shell alone: a scratch
# config directory, the keyfile backend reading it, and a bus of its own.
export XDG_CONFIG_HOME="$RUN_DIR/config"
export GSETTINGS_BACKEND=keyfile
unset DCONF_PROFILE
eval "$(dbus-launch --sh-syntax)"

LOG="$RUN_DIR/shell.log"
if [[ "$mode" == "window" ]]; then
    info "Starting a nested GNOME Shell in a window..."
    gnome-shell --nested --wayland > "$LOG" 2>&1 &
else
    info "Starting a headless GNOME Shell..."
    gnome-shell --headless --virtual-monitor 1400x800 > "$LOG" 2>&1 &
fi
SHELL_PID=$!

# It answers on its own bus once it is up; a shell that dies instead never
# will, so the wait is bounded and the log is what says why.
for _ in $(seq 40); do
    sleep 0.5
    kill -0 "$SHELL_PID" 2>/dev/null || die "The shell exited. Its output:
$(tail -20 "$LOG")"
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion \
        >/dev/null 2>&1 && break
done

version="$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion 2>/dev/null \
    | grep -o "'[0-9.]*'" | tr -d "'")"
[[ -n "$version" ]] || die "The shell never came up. Its output:
$(tail -20 "$LOG")"
ok "GNOME Shell $version is up, with only $UUID enabled."

# Give it a moment to enable the extension and let the first poll go out.
sleep 3

# State 1 is enabled; anything else, and `error` says what the shell made of it.
state="$(gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>/dev/null)"
case "$state" in
    *"'state': <1"*) ok "The extension is enabled." ;;
    "")              warn "The shell would not say -- it may still be starting." ;;
    *)               warn "Not enabled. The shell says: $(sed "s/.*'error': <'\([^']*\)'>.*/\1/" <<< "$state")" ;;
esac

echo
printf '\033[1m%s\033[0m\n' "What it said for itself"
if grep -q '\[AI Usage\]' "$LOG"; then
    grep '\[AI Usage\]' "$LOG" | sed 's/.*\[AI Usage\] /  /'
else
    echo "  (nothing -- 'make link' installs the entry point that turns logging up)"
fi

errors="$(grep -E 'JS ERROR|Extension .* error' "$LOG" | head -5)"
if [[ -n "$errors" ]]; then
    echo
    printf '\033[1;31m%s\033[0m\n' "Errors"
    sed 's/^/  /' <<< "$errors"
fi

if [[ "$mode" == "window" ]]; then
    echo
    info "The window is the nested shell. Close it, or press Ctrl+C here, to stop."
    wait "$SHELL_PID"
elif [[ "$keep" == "yes" ]]; then
    echo
    info "Left running. Its log: $LOG"
    info "Press Ctrl+C to stop it."
    wait "$SHELL_PID"
else
    echo
    info "Stopped. Its log, until the next run: $LOG"
fi
