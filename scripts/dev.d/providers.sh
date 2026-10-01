# What the extension would see, outside the shell.
#
#   ./scripts/dev.sh providers  print, for each provider, whether its command-line
#                               tool is installed, whether a login is stored, and the
#                               figures that come back. Reads the real stored logins
#                               and goes to the network: the user's to run
#

# What the extension would see, run through the extension's own provider code.
cmd_providers() {
    require gjs
    gjs -m "$REPO_DIR/scripts/providers.js"
}
