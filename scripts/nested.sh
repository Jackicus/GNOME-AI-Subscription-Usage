#!/usr/bin/env bash
#
# Runs this extension in a throwaway GNOME Shell, so that it can be seen
# without logging out of the one you are using.
#
#   ./scripts/dev.sh nested            headless: load it, say what it built, stop
#   ./scripts/dev.sh nested --window   a nested shell in a window, to look at
#   ./scripts/dev.sh nested --keep     headless, but left running, and told how
#                                      to drive it by hand
#   ./scripts/dev.sh shots             headless: load it, drive it, and write
#                                      docs/screenshots/
#   ./scripts/dev.sh shots --light     the same, with the throwaway shell set to
#                                      the light preference: the top bar and a
#                                      pop-up, as *-light.png
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
#     are actually using, is never opened, let alone written. Any of this
#     extension's own settings can be tried the same way: append
#
#         [org/gnome/shell/extensions/ai-usage]
#         panel-mode='combined'
#
#     to $RUN_DIR/config/glib-2.0/settings/keyfile. The backend watches that
#     file, so a `--keep` shell picks the change up without a restart -- which
#     is how the pop-up's actions were checked to be drawn once and not once
#     per provider;
#   * its own Wayland socket, so a preferences window opened against it lands
#     there and not on your desktop;
#   * only this extension enabled, so anything that goes wrong is ours.
#
# It reads the extension from where an install put it, which means `link` or
# `install` first. `link` is the one to want: its entry point turns the
# logging up, and the lines below are then worth reading.
#
# Headless used to prove only that it loads. It proves more than that now:
# scripts/nested_driver.py screenshots the throwaway shell and works its
# controls, so `shots` can open a pop-up and photograph it. The one thing that
# makes that possible is in the driver's own header -- the shell refuses
# org.gnome.Shell.Screenshot to callers that are not one of a few known
# services, and on a private bus that name is there for the taking.

set -uo pipefail

UUID="ai-usage@jackicus"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/ai-usage-nested"
DRIVER="$REPO_DIR/scripts/nested_driver.py"
SHOT_DIR="$REPO_DIR/docs/screenshots"

# The throwaway shell's own Wayland socket. Named, rather than left to mutter's
# first free number, so that a client can be pointed at it by name -- and not
# after the run directory above, whose path mutter would try to bind over.
WL_DISPLAY="ai-usage-dev"
GEOMETRY="1600x900"

# How long to let the readings settle before photographing the top bar. Every
# provider is polled at once, and the slowest one sets this: Antigravity keeps
# its login in the secret service, a throwaway bus has none, and the lookup ends
# in a D-Bus activation timeout about 25 seconds later. Until it does, that
# button is still an ellipsis -- which is wider than the nothing it settles on,
# and so moves every other button along the bar.
SETTLE_SECONDS=35

# Where to click, on a 1600x900 monitor with the buttons where they go by
# default (the right-hand end, nearest the middle). Measured, because the shell
# offers no way to ask an actor where it is: take a `shot` and look. Measured
# *while the driver holds its input session*, which is the only state a click
# ever happens in -- that session is a screencast, the shell puts a recording
# indicator in the top bar for it, and everything to the indicator's left shifts
# along. The indicator is gone from the pictures, because a screenshot is taken
# by a later run of the driver, after the one that clicked has exited.
#
# Anything that changes how wide a button is moves this: the stylesheet's panel
# padding, the icon size, how many digits the figure has. A stale coordinate
# does not fail -- it clicks the bar, nothing opens, and the pop-up picture is
# of the wallpaper. `--keep` prints how to take a fresh `shot` and measure again.
CLAUDE_BUTTON="1339 16"
# The preferences window opens centred, so its tabs are at fixed points too.
TAB_BUTTONS="677 201"
TAB_READINGS="799 201"
TAB_PROVIDERS="922 201"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

mode="headless"
keep="no"
shots="no"
light="no"
for arg in "$@"; do
    case "$arg" in
        --window)  mode="window" ;;
        --keep)    keep="yes" ;;
        --shots)   shots="yes" ;;
        --light)   light="yes" ;;
        *)         die "Unknown option '$arg'. Try --window, --keep, --shots or --light." ;;
    esac
done

command -v gnome-shell >/dev/null || die "'gnome-shell' not found in PATH."
command -v dbus-launch >/dev/null || die "'dbus-launch' not found in PATH (install dbus)."
[[ -e "$EXT_DIR" || -L "$EXT_DIR" ]] || die "Nothing installed at $EXT_DIR. Run 'make link' first."

if [[ "$shots" == "yes" ]]; then
    [[ "$mode" == "window" ]] && die "--shots drives a headless shell; drop --window."
    command -v python3 >/dev/null || die "'python3' not found in PATH; the driver needs it."
    python3 -c 'import gi' 2>/dev/null || die "python3 has no 'gi' (install python-gobject); the driver needs it."
fi

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

# Nothing in the pop-up hardcodes a foreground colour, which is only worth
# anything if it has been looked at both ways round. Because the throwaway
# shell's settings are that one file, the other way round is these two lines --
# and the pictures are named apart so a run in one theme does not overwrite the
# other's.
SUFFIX=""
if [[ "$light" == "yes" ]]; then
    cat >> "$RUN_DIR/config/glib-2.0/settings/keyfile" <<EOF

[org/gnome/desktop/interface]
color-scheme='prefer-light'
EOF
    SUFFIX="-light"
fi

cleanup() {
    [[ -n "${PREFS_PID:-}" ]] && kill "$PREFS_PID" 2>/dev/null
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
    gnome-shell --nested --wayland --wayland-display "$WL_DISPLAY" > "$LOG" 2>&1 &
else
    info "Starting a headless GNOME Shell..."
    # DISPLAY is dropped so that nothing this session starts can reach the real
    # desktop's Xwayland instead of the throwaway shell.
    env -u DISPLAY gnome-shell --headless --wayland-display "$WL_DISPLAY" \
        --virtual-monitor "$GEOMETRY" > "$LOG" 2>&1 &
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

# One run of the driver over a list of steps. Each call is its own process on
# purpose: the virtual pointer is a screencast session, and the shell only takes
# its recording indicator out of the top bar when the process that asked for one
# has gone. So a click and the photograph of what it opened are separate calls.
drive() {
    env -u DISPLAY WAYLAND_DISPLAY="$WL_DISPLAY" \
        NESTED_GEOMETRY="$GEOMETRY" NESTED_RUN_DIR="$RUN_DIR" NESTED_SHOT_DIR="$SHOT_DIR" \
        python3 "$DRIVER" batch "$@" >/dev/null \
        || { warn "The driver could not run: $*"; return 1; }
}

# The preferences are a separate process, and an ordinary Wayland client: point
# it at the throwaway shell's socket and its window opens in there.
open_prefs() {
    env -u DISPLAY WAYLAND_DISPLAY="$WL_DISPLAY" GDK_BACKEND=wayland \
        gnome-extensions prefs "$UUID" >> "$LOG" 2>&1 &
    PREFS_PID=$!
    sleep 5
}

take_shots() {
    mkdir -p "$SHOT_DIR"
    info "Letting the readings settle (${SETTLE_SECONDS}s)..."
    sleep "$SETTLE_SECONDS"

    info "Photographing the top bar..."
    # A strip of the right-hand end, where the buttons go by default. Nothing is
    # clicked first, so this picture has no recording indicator in it at all.
    drive "shot $SHOT_DIR/top-bar$SUFFIX.png 1100 0 500 36"
    # The tighter crop the README opens with: the two buttons and the icons
    # either side of them, and no more. Taken from the shell rather than cut out
    # of the strip above by hand afterwards, because a picture nobody can
    # regenerate is a picture that goes stale the first time the buttons move --
    # which is exactly what happened to it. Dark only; the README has one.
    [[ "$light" == "no" ]] && drive "shot $SHOT_DIR/top-bar-cropped.png 1354 0 244 28"

    info "Opening a button's pop-up..."
    drive "click $CLAUDE_BUTTON" "wait 1.5"
    # The recording indicator outlives the process that asked for it by a few
    # seconds, so wait it out rather than photograph the shell mid-tidy. Six is
    # measured: it was still there at four and gone by six.
    drive "wait 6" "shot $SHOT_DIR/pop-up$SUFFIX.png 1085 0 500 260"
    drive "key Escape"

    # The preferences are a GTK window and follow their own colour setting
    # rather than the shell's, so photographing them again in the other theme
    # would give the same three pictures under different names.
    if [[ "$light" == "yes" ]]; then
        report_shots
        return
    fi

    info "Opening the preferences..."
    open_prefs
    # ScreenshotWindow takes the focused window with its frame, and leaves the
    # corners transparent -- the same picture the other five extensions carry.
    # The first page is the one it opens on, but say so rather than rely on it.
    drive "click $TAB_BUTTONS" "wait 1"
    drive "window $SHOT_DIR/preferences-buttons.png"
    drive "click $TAB_READINGS" "wait 1"
    drive "window $SHOT_DIR/preferences-readings.png"
    drive "click $TAB_PROVIDERS" "wait 1"
    drive "window $SHOT_DIR/preferences-providers.png"

    report_shots
}

report_shots() {
    echo
    printf '\033[1m%s\033[0m\n' "Screenshots"
    local shot
    for shot in "$SHOT_DIR"/*.png; do
        [[ -e "$shot" ]] || continue
        printf '  %s\n' "${shot#"$REPO_DIR"/}"
    done
}

[[ "$shots" == "yes" ]] && take_shots

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
    info "Drive it, or re-measure where a button sits, with:"
    echo "    env -u DISPLAY DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS' \\"
    echo "        WAYLAND_DISPLAY=$WL_DISPLAY NESTED_GEOMETRY=$GEOMETRY \\"
    echo "        python3 $DRIVER batch 'shot /tmp/bar.png 0 0 ${GEOMETRY%x*} 36'"
    info "Press Ctrl+C to stop it."
    wait "$SHELL_PID"
else
    echo
    info "Stopped. Its log, until the next run: $LOG"
fi
