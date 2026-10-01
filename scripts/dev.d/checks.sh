# AI Usage's own checks, which 'dev.sh check' (and so 'make check' and CI) runs
# after the schema, as EXT_CHECKS in scripts/ext.conf names them.
#
#   ./scripts/dev.sh imports    check that the preferences can still load what they
#                               load: nothing in prefs.js's import graph may reach St,
#                               Clutter, Meta, Shell, Soup or resource:// paths
#   ./scripts/dev.sh assets     check that every icon that ships loads as one, and
#                               that every icon a provider asks for is there
#   ./scripts/dev.sh parsers    run each provider's parser over a saved response and
#                               check what comes out -- the only check at all for a
#                               provider whose tool is not installed here
#

# The import-graph check: prefs.js runs without the shell, so nothing it reaches
# may import St, Clutter, Meta, Shell, Soup or resource:// paths.
cmd_imports() {
    require gjs
    gjs -m "$REPO_DIR/scripts/imports.js"
}

# The icon checks: an SVG that gdk-pixbuf will not recognise ships happily and
# shows nothing, which is a bug that once survived to the first screenshot.
cmd_assets() {
    require gjs
    gjs -m "$REPO_DIR/scripts/assets.js"
}

# The parser checks. Fixtures live in tests/fixtures/.
cmd_parsers() {
    require gjs
    gjs -m "$REPO_DIR/scripts/parsers.js"
}
