# The stand-in world 'start --stand-in' (and so 'shots') runs in, because the
# pictures go into a public repository. Besides what the kit's nested.sh does
# (a scratch HOME, the system's PATH only, stand-in claude, codex and agy
# overlaid on /usr/bin as EXT_STAND_IN_BINS names them, so the preferences say
# "found at /usr/bin/claude" whatever your own PATH holds):
#
#   * stand-in logins in that HOME, which are not anyone's: every token is the
#     word "stand-in" (Codex's wrapped as a JWT, whose claims codex.js reads);
#   * scripts/stand-in-http.js staged over lib/http.js in the session's copy of
#     the extension, so the providers reach no network, never send the token
#     anywhere, and show invented figures.
#
# A provider added without an answer in stand-in-http.js shows as unavailable.

# nested_stand_in_stage STAGE: every time the extension is staged, reload included.
nested_stand_in_stage() {
    cp "$REPO_DIR/scripts/stand-in-http.js" "$1/lib/http.js"
}

# nested_stand_in HOME STAGE: once per start.
nested_stand_in() {
    local home="$1"
    mkdir -p "$home/.claude" "$home/.codex" "$home/.gemini/antigravity-cli"
    cat > "$home/.claude/.credentials.json" <<'EOF'
{"claudeAiOauth": {"accessToken": "stand-in", "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x"}}
EOF
    cat > "$home/.claude.json" <<'EOF'
{"oauthAccount": {"organizationRateLimitTier": "default_claude_max_5x"}}
EOF
    cat > "$home/.gemini/antigravity-cli/antigravity-oauth-token" <<EOF
{"token": {"access_token": "stand-in", "expiry": "$(date -u -d '+1 day' +%FT%TZ)"}}
EOF
    local claims
    claims="$(printf '{"exp": %s, "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}}' \
        "$(date -u -d '+1 day' +%s)" | base64 -w0 | tr '+/' '-_' | tr -d '=')"
    cat > "$home/.codex/auth.json" <<EOF
{"auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": {"id_token": "stand-in", "access_token": "stand-in.$claims.stand-in", "refresh_token": "stand-in", "account_id": "00000000-0000-4000-8000-000000000000"}, "last_refresh": "$(date -u +%FT%TZ)"}
EOF
}
