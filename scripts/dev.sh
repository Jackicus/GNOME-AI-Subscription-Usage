#!/usr/bin/env bash
#
# AI Usage development helper.
#
#   ./scripts/dev.sh link       link src/ into the extensions dir (dev mode)
#   ./scripts/dev.sh install    copy src/ into the extensions dir (real install)
#   ./scripts/dev.sh reload     recompile schemas and disable/enable the extension
#   ./scripts/dev.sh logs [since]  shell logs; follows unless given e.g. '5 min ago'
#   ./scripts/dev.sh pack       build dist/<uuid>.shell-extension.zip for extensions.gnome.org
#   ./scripts/dev.sh providers  print what the extension would see: for each
#                               provider, whether its command-line tool is
#                               installed, whether a login is stored, and the
#                               figures that come back
#   ./scripts/dev.sh nested     run it in a throwaway GNOME Shell -- headless by
#                               default, '--window' to look at it -- so a new
#                               extension can be seen without logging out
#   ./scripts/dev.sh shots      the same throwaway shell, driven: open a button's
#                               pop-up and the preferences, and write the
#                               pictures to docs/screenshots/
#   ./scripts/dev.sh assets     check that every icon that ships loads as one,
#                               and that every icon a provider asks for is there
#   ./scripts/dev.sh imports    check that the preferences can still load what
#                               they load: nothing in prefs.js's import graph
#                               may reach St, Clutter or Soup
#   ./scripts/dev.sh parsers    run each provider's parser over a saved response
#                               and check what comes out -- the only test that
#                               needs no GNOME Shell, and the only check at all
#                               for a provider whose tool is not installed here
#   ./scripts/dev.sh uninstall  remove the extension
#   ./scripts/dev.sh status     show what is currently installed and enabled
#   ./scripts/dev.sh clean      remove the compiled schema and what the scripts
#                               put in dist/
#
set -euo pipefail

UUID="ai-usage@jackicus"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_DIR/src"
EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"
EXT_DIR="$EXT_ROOT/$UUID"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH."
}

compile_schemas() {
    require glib-compile-schemas
    info "Compiling GSettings schemas..."
    glib-compile-schemas "$SRC_DIR/schemas"
}

remove_installed() {
    # -e misses a symlink whose target is gone, so test -L as well.
    if [[ -e "$EXT_DIR" || -L "$EXT_DIR" ]]; then
        rm -rf "$EXT_DIR"
    fi
}

is_enabled() {
    gnome-extensions list --enabled 2>/dev/null | grep -qx "$UUID"
}

# The extension directory as links into src/ -- except its entry point, which is
# scripts/dev-extension.js: that one imports lib/ from a fresh copy on every
# edit, so a reload runs what is on disk. Everything that ships is src/'s own.
link_tree() {
    mkdir -p "$EXT_DIR"
    local entry
    for entry in "$SRC_DIR"/*; do
        [[ "$(basename "$entry")" == extension.js ]] && continue
        ln -s "$entry" "$EXT_DIR/$(basename "$entry")"
    done
    ln -s "$REPO_DIR/scripts/dev-extension.js" "$EXT_DIR/extension.js"
}

cmd_link() {
    compile_schemas
    remove_installed
    link_tree
    ok "Linked $EXT_DIR → $SRC_DIR (entry point: scripts/dev-extension.js)"
    warn "Dev mode: edits in src/ are live. Run './scripts/dev.sh reload' to apply them."
    enable_extension
}

cmd_install() {
    compile_schemas
    remove_installed
    mkdir -p "$EXT_DIR"
    cp -r "$SRC_DIR"/. "$EXT_DIR"/
    ok "Installed to $EXT_DIR"
    enable_extension
}

enable_extension() {
    require gnome-extensions
    if is_enabled; then
        cmd_reload
    else
        info "Enabling $UUID..."
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            ok "Enabled."
        else
            warn "The running GNOME Shell does not know about $UUID yet."
            warn "Log out and back in (Wayland) or Alt+F2 'r' (X11), then: gnome-extensions enable $UUID"
        fi
    fi
}

# Poll until the shell reports the wanted state, up to ~6s.
wait_for_state() {
    local want="$1" tries=0
    while (( tries < 60 )); do
        [[ "$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p')" == "$want" ]] && return 0
        sleep 0.1
        tries=$((tries + 1))
    done
    return 1
}

cmd_reload() {
    require gnome-extensions
    compile_schemas
    info "Reloading $UUID..."
    gnome-extensions disable "$UUID" 2>/dev/null || true
    # The shell applies disable asynchronously. Calling enable before it lands is
    # a silent no-op -- the shell still believes the extension is enabled, so it
    # never re-runs enable(), and you are left with State: INACTIVE, Enabled: Yes
    # and nothing at all in the log.
    wait_for_state INACTIVE || warn "Extension did not report INACTIVE; enabling anyway."
    gnome-extensions enable "$UUID"
    if wait_for_state ACTIVE; then
        ok "Reloaded. The development entry point re-imports lib/, so no shell restart needed."
    else
        warn "Extension is enabled but not ACTIVE. Check './scripts/dev.sh logs' for a JS error."
        return 1
    fi
}

# With no argument, follow the journal. With one (any systemd time spec, e.g.
# "5 min ago" or "today"), print what is already there and exit -- which is what
# non-interactive callers need.
cmd_logs() {
    require journalctl
    if [[ -n "${1:-}" ]]; then
        info "AI Usage log output since '$1':"
        journalctl -o cat /usr/bin/gnome-shell --since "$1" 2>/dev/null \
            | grep -iE 'ai.usage' || info "(nothing logged in that window)"
    else
        info "Following GNOME Shell logs (Ctrl+C to stop)..."
        journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -iE 'ai.usage'
    fi
}

# The zip for extensions.gnome.org. gnome-extensions picks up extension.js,
# prefs.js, metadata.json, stylesheet.css and schemas/*.gschema.xml by itself;
# lib/, icons/ and the licence have to be named. The schema ships as XML only:
# GNOME 44 and later compile it on install.
cmd_pack() {
    require gnome-extensions
    require glib-compile-schemas
    require unzip
    local out="$REPO_DIR/dist"
    local zip="$out/$UUID.shell-extension.zip"

    # An install compiles the schema with --strict, so a warning here is a
    # failed install there.
    glib-compile-schemas --strict --dry-run "$SRC_DIR/schemas" || die "The schema does not pass --strict."

    mkdir -p "$out"
    info "Packing $UUID..."
    gnome-extensions pack "$SRC_DIR" --extra-source=lib --extra-source=icons \
        --extra-source="$REPO_DIR/LICENSE" --out-dir="$out" --force

    # gnome-extensions 45 and older still compile the schema into the bundle.
    if unzip -Z1 "$zip" | grep -qx 'schemas/gschemas.compiled'; then
        require zip
        zip -qd "$zip" schemas/gschemas.compiled
    fi

    check_pack "$zip"
    unzip -l "$zip"
    ok "Packed $zip"
}

# Everything that should ship is in the zip, and nothing else is. A stray file
# in lib/ (an editor backup, a note) fails here rather than going to review.
check_pack() {
    local zip="$1" expected actual missing extra
    expected="$(
        cd "$SRC_DIR"
        printf '%s\n' extension.js prefs.js metadata.json stylesheet.css schemas/*.gschema.xml LICENSE
        find lib -type f -name '*.js' | sort
        find icons -type f -name '*.svg' | sort
    )"
    actual="$(unzip -Z1 "$zip" | grep -v '/$')"

    missing="$(comm -23 <(sort <<<"$expected") <(sort <<<"$actual"))"
    extra="$(comm -13 <(sort <<<"$expected") <(sort <<<"$actual"))"
    [[ -z "$missing" ]] || die "Missing from the zip:"$'\n'"$missing"
    [[ -z "$extra" ]] || die "Should not be in the zip:"$'\n'"$extra"
    ok "Zip holds exactly the $(wc -l <<<"$expected") files that should ship."
}

# What the extension would see, run through the extension's own provider code.
cmd_providers() {
    require gjs
    gjs -m "$REPO_DIR/scripts/providers.js"
}

# A throwaway GNOME Shell with only this extension in it. See scripts/nested.sh
# for what it does and does not touch.
cmd_nested() {
    "$REPO_DIR/scripts/nested.sh" "$@"
}

# The same throwaway shell, with scripts/nested_driver.py working its controls
# and photographing the result. Everything it writes goes to docs/screenshots/.
cmd_shots() {
    "$REPO_DIR/scripts/nested.sh" --shots "$@"
}

# The icon checks: an SVG that gdk-pixbuf will not recognise ships happily and
# shows nothing, which is a bug that once survived to the first screenshot.
cmd_assets() {
    require gjs
    gjs -m "$REPO_DIR/scripts/assets.js"
}

# The import-graph check: prefs.js runs without the shell, so nothing it reaches
# may import St, Clutter or Soup.
cmd_imports() {
    require gjs
    gjs -m "$REPO_DIR/scripts/imports.js"
}

# The parser checks. Fixtures live in tests/fixtures/.
cmd_parsers() {
    require gjs
    gjs -m "$REPO_DIR/scripts/parsers.js"
}

cmd_uninstall() {
    remove_installed
    ok "Removed $EXT_DIR"
}

cmd_clean() {
    rm -f "$SRC_DIR/schemas/gschemas.compiled"
    rm -f "$REPO_DIR"/dist/*.shell-extension.zip
    ok "Cleaned the compiled schema and the zip."
}

cmd_status() {
    if [[ -L "$EXT_DIR/extension.js" ]]; then
        echo "install:  link → $SRC_DIR (entry point: $(readlink -f "$EXT_DIR/extension.js"))"
    elif [[ -d "$EXT_DIR" ]]; then
        echo "install:  copy at $EXT_DIR"
    else
        echo "install:  not installed"
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        local state
        # pipefail would abort the script when the extension is not registered yet
        state="$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p' || true)"
        echo "state:    ${state:-unknown to the running shell (log out and back in)}"
    fi
    local cli
    for cli in claude; do
        if command -v "$cli" >/dev/null 2>&1; then
            echo "$cli:   $(command -v "$cli") (run './scripts/dev.sh providers' for its figures)"
        else
            echo "$cli:   not installed -- that provider is left out"
        fi
    done
}

usage() {
    # Print the comment header (everything after the shebang, up to the first
    # blank non-comment line), stripping the leading '#'.
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

case "${1:-}" in
    link)       cmd_link ;;
    install)    cmd_install ;;
    reload)     cmd_reload ;;
    logs)       cmd_logs "${2:-}" ;;
    pack)       cmd_pack ;;
    providers)  cmd_providers ;;
    nested)     shift; cmd_nested "$@" ;;
    shots)      shift; cmd_shots "$@" ;;
    assets)     cmd_assets ;;
    imports)    cmd_imports ;;
    parsers)    cmd_parsers ;;
    uninstall)  cmd_uninstall ;;
    status)     cmd_status ;;
    clean)      cmd_clean ;;
    ""|-h|--help|help) usage ;;
    *)          die "Unknown command '$1'. Run './scripts/dev.sh help'." ;;
esac
