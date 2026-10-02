# The published screenshots, taken in a nested shell of their own over stand-in
# data (scripts/nested.d/stand-in.sh), never over yours.
#
#   ./scripts/nested.sh shots [--light] [--out DIR]
#                                     start a stand-in nested shell (headless), open a
#                                     button's pop-up and the preferences, write the
#                                     pictures to docs/screenshots/ (or DIR), and stop
#                                     it; --light does the top bar and the pop-up again
#                                     in a light shell, as *-light.png
#

# How long to let the readings settle before photographing the top bar. Every
# provider is polled at once, and the slowest one sets this: Antigravity keeps
# its login in the secret service, a throwaway bus has none, and the lookup ends
# in a D-Bus activation timeout about 25 seconds later, after which it falls
# back to the stand-in token file. Until it does, that button is still an
# ellipsis -- which is wider than what it settles on, and so moves every other
# button along the bar.
SHOTS_SETTLE=35

# Where to click, on a 1600x900 monitor with the buttons where they go by
# default (the right-hand end, nearest the middle). Measured, because the shell
# offers no way to ask an actor where it is: take a `shot` and look. Measured
# *while the driver holds its input session*, which is the only state a click
# ever happens in -- that session is a screencast, the shell puts a recording
# indicator in the top bar for it, and everything to the indicator's left shifts
# along. The indicator is gone from the pictures, because a screenshot is taken
# by a later run of the driver (a later 'do'), after the one that clicked has
# exited.
#
# Anything that changes how wide a button is moves this: the stylesheet's panel
# padding, the icon size, how many digits the figure has, the font. A stale
# coordinate does not fail -- it clicks the bar, nothing opens, and the pop-up
# picture is of the wallpaper. Re-measure with 'start --stand-in --headless' and
# a 'do "click 1235 16" "shot FILE 0 0 1600 36"'.
SHOTS_CLAUDE_BUTTON="1235 16"
# The preferences window opens centred, so its tabs are at fixed points too.
SHOTS_TAB_BUTTONS="677 201"
SHOTS_TAB_READINGS="799 201"
SHOTS_TAB_PROVIDERS="922 201"

cmd_shots() {
    local light=0 out="$REPO_DIR/docs/screenshots" status=0
    while (( $# )); do
        case "$1" in
            --light) light=1 ;;
            --out)   out="${2:-}"; [[ -n "$out" ]] || die "--out takes a directory."; shift ;;
            *)       die "Unknown shots option '$1'. Usage: shots [--light] [--out DIR]" ;;
        esac
        shift
    done
    is_running && die "A nested shell is running: './scripts/nested.sh stop' it first. Shots start one of their own, over stand-in data."
    command -v python3 >/dev/null || die "'python3' not found in PATH; the driver needs it."
    python3 -c 'import gi' 2>/dev/null || die "python3 has no 'gi' (install python-gobject); the driver needs it."
    mkdir -p "$out"
    out="$(cd "$out" && pwd)"

    cmd_start --stand-in --headless || return 1
    shots_take "$light" "$out" || status=1
    shots_errors
    stop_session "" || status=1
    (( status == 0 )) || return 1
    shots_report "$out"
}

# One run of the driver over a list of steps. Each call is its own process on
# purpose: the virtual pointer is a screencast session, and the shell only takes
# its recording indicator out of the top bar when the process that asked for one
# has gone. So a click and the photograph of what it opened are separate calls.
shots_do() {
    cmd_do "$@" >/dev/null || { warn "The driver could not run: $*"; return 1; }
}

shots_take() {
    local light="$1" out="$2" suffix=""
    (( light )) && suffix="-light"

    # Nothing in the pop-up hardcodes a foreground colour, which is only worth
    # anything if it has been looked at both ways round; the pictures are named
    # apart so a run in one scheme does not overwrite the other's.
    if (( light )); then
        cmd_run timeout 5 gsettings set org.gnome.desktop.interface color-scheme prefer-light || return 1
    fi

    info "Letting the readings settle (${SHOTS_SETTLE}s)..."
    sleep "$SHOTS_SETTLE"

    info "Photographing the top bar..."
    # A strip of the right-hand end, where the buttons go by default. Nothing is
    # clicked first, so this picture has no recording indicator in it at all.
    shots_do "shot $out/top-bar$suffix.png 1100 0 500 36" || return 1
    # The tighter crop the README opens with: the three buttons and the icons
    # either side of them, and no more. Taken from the shell rather than cut out
    # of the strip above by hand afterwards, because a picture nobody can
    # regenerate goes stale the first time the buttons move. Dark only; the
    # README has one.
    if (( ! light )); then
        shots_do "shot $out/top-bar-cropped.png 1248 0 350 28" || return 1
    fi

    info "Opening a button's pop-up..."
    shots_do "click $SHOTS_CLAUDE_BUTTON" "wait 1.5" || return 1
    # The recording indicator outlives the process that asked for it by a few
    # seconds, so wait it out rather than photograph the shell mid-tidy. Six is
    # measured: it was still there at four and gone by six.
    shots_do "wait 6" "shot $out/pop-up$suffix.png 1016 0 569 330" || return 1
    shots_do "key Escape" || return 1

    # The preferences are a GTK window and follow their own colour setting
    # rather than the shell's, so photographing them again in the other scheme
    # would give the same three pictures under different names.
    (( light )) && return 0

    info "Opening the preferences..."
    # The window is the Extensions app's, D-Bus activated on the nested bus, so
    # it runs in the stand-in world too; 'stop' closes it.
    cmd_run gnome-extensions prefs "$EXT_UUID" >>"$LOG_FILE" 2>&1 &
    sleep 5
    # The window step takes the focused window with its frame. The first page is
    # the one it opens on, but say so rather than rely on it.
    shots_do "click $SHOTS_TAB_BUTTONS" "wait 1" || return 1
    shots_do "window $out/preferences-buttons.png" || return 1
    shots_do "click $SHOTS_TAB_READINGS" "wait 1" || return 1
    shots_do "window $out/preferences-readings.png" || return 1
    shots_do "click $SHOTS_TAB_PROVIDERS" "wait 1" || return 1
    shots_do "window $out/preferences-providers.png" || return 1
}

# What went wrong in the session, while its log is still there. Antigravity's
# keyring timeout is expected here and is not one of these.
shots_errors() {
    local errors
    errors="$(grep -E 'JS ERROR|Extension .* error|\[AI Usage\] (Failed to load|Error during disable)' "$LOG_FILE" 2>/dev/null | head -5 || true)"
    [[ -z "$errors" ]] && return 0
    echo
    printf '\033[1;31m%s\033[0m\n' "Errors"
    sed 's/^/  /' <<< "$errors"
}

# The shell's screenshot writes a creation time and a timezone into each PNG; a
# public picture carries pixels only. oxipng also shrinks them.
shots_report() {
    local out="$1" shot
    if command -v oxipng >/dev/null 2>&1; then
        oxipng --quiet --opt 4 --strip safe "$out"/*.png
    else
        warn "oxipng is not installed: the shots still carry their text chunks. Strip them before committing."
    fi
    echo
    printf '\033[1m%s\033[0m\n' "Screenshots"
    for shot in "$out"/*.png; do
        [[ -e "$shot" ]] && printf '  %s\n' "${shot#"$REPO_DIR"/}"
    done
    return 0
}
