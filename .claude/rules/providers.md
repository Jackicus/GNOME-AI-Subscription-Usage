---
paths:
  - "src/lib/providers/**"
  - "src/lib/http.js"
  - "tests/fixtures/**"
  - "scripts/parsers.js"
  - "scripts/providers.js"
---

# The providers: where the numbers come from

## Claude

`GET https://api.anthropic.com/api/oauth/usage` with the OAuth access token from
`~/.claude/.credentials.json` and `anthropic-beta: oauth-2025-04-20` — the
request Claude Code's own `/usage` makes, so the button and the terminal agree.
The header is not currently required; it is sent to look exactly like the tool.

The useful part is `limits[]`: one row per limit with `percent`, `severity`,
`resets_at`, `is_active`, and `scope.model` on per-model rows; an unknown `kind`
is shown under a label made from its name. The top-level `five_hour`/`seven_day`
are the fallback. `seven_day_breakdown` says where the week went;
`extra_usage`/`spend` are paid credits — when disabled, a `percent: null` credits
entry drawn as an "Extra usage · off" line with no bar.

**The plan name** is not in that response, and it is *not* the credentials'
`rateLimitTier` — that is stamped at sign-in and never rewritten, so an upgraded
account reports its old plan. It comes from `~/.claude.json` →
`oauthAccount.organizationRateLimitTier` (then `userRateLimitTier`), which Claude
Code refreshes on start: a second file read, not a second request. Only the tier
is taken from that file. Absent or unreadable falls back to the credentials tier,
then `subscriptionType` — a missing plan name is fine, a wrong one is not.

**The endpoint is undocumented and its shape moves** — it carries codenamed
fields (`iguana_necktie`, `nimbus_quill`, …), which are never touched. Parsers
read defensively and return `Status.UNAVAILABLE` rather than throw or show a
wrong number.

## Antigravity

`agy` keeps its login in the **secret service**; the file
`~/.gemini/antigravity-cli/antigravity-oauth-token` is only written without a
D-Bus session and is stale on a desktop, so the keyring is tried first. Two
POSTs to `cloudcode-pa.googleapis.com`: `loadCodeAssist` (project id, kept until
a token is rejected or the extension is disabled: the app reads through a copy
of each provider made per enable) then `retrieveUserQuotaSummary`.

* It answers **403** to a User-Agent not starting `antigravity`, which is why
  `Http` sets no session-wide agent and each provider passes its own.
* **The response says what is LEFT**; everything else here shows USED. Its own
  "Weekly Limit Remaining" label would lie over the inverted figure, so labels
  are built from window and model family. A parser check pins 0, 1 and 0.35.

## Adding a provider

1. Find the request the CLI makes for its own usage command (`strings` over the
   binary, grepped for `usage`/`limit`, is how `/api/oauth/usage` was found),
   and where the tool stores its login.
2. Write `src/lib/providers/<id>.js` mapping the response onto `Limit`s, using
   `common.js` (Readings, login files, labels, timestamps, failures) and
   `stringOrNull`/`numberOrNull` from `usage.js` for outside data.
   The provider is an object: `id` (the settings path and the panel role),
   `displayName`, `cli` (looked for on `PATH`) and `cliName` (named in the
   sign-in message), `icon` (a stock Adwaita symbolic's name that no other
   provider uses, never the company's mark or one drawn after it: README,
   Credits and trademarks; `make assets` checks it), `capabilities`
   (which of `perModel`, `breakdown`, `credits` it can honour),
   `credentialsFile()` (watched, so the tool's refresh is read at once) and
   `read(http, cancellable)`, resolving to a `Reading`, the login read afresh
   each call. Contract: never throw (return a `Reading` with a `Status`; only a
   cancellation, which `failureReading()` throws on, goes up), never write to the
   provider's files, never log in, and pull nothing of St, Clutter or Soup into
   the prefs process — read `e.status` duck-typed, as `failureReading()` does.
   `make imports` enforces the last.
3. Register it in `registry.js`; preferences, settings and `make providers`
   follow. Add a fixture under `tests/fixtures/` and checks in `scripts/parsers.js`.
