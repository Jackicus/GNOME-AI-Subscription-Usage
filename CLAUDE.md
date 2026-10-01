# AI Usage

A GNOME Shell extension (UUID `ai-usage@jackicus`; GJS, ES modules, shell 50)
that puts a button in the top bar per AI subscription, showing how much of each
rate limit is used and when it resets. Claude and Antigravity are verified
against live accounts; Codex was written from source and has never run.

## The rule the whole design hangs off

**This extension never signs anyone in.** It reads the login that a provider's
own command-line tool has already stored, and does nothing else with it:

* The CLI is a hard requirement: a provider whose command is not on `PATH` gets
  no button at all, rather than a broken one.
* It never refreshes a token. Refreshing Claude's rotates the refresh token and
  could sign the user out of Claude Code. A rejected token (401/403) is
  `Status.EXPIRED`, and the button asks the user to run the tool once.
* Tokens are read fresh on every poll and never held — the tool rewrites the
  file when it refreshes, so a cached token is a stale one.
* Nothing is ever written to a provider's files; no token is logged, ever.

## Where Claude's numbers come from

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

## Other providers' traps

**Antigravity** (`agy`) keeps its login in the **secret service**; the file
`~/.gemini/antigravity-cli/antigravity-oauth-token` is only written without a
D-Bus session and is stale on a desktop, so the keyring is tried first. Two
POSTs to `cloudcode-pa.googleapis.com`: `loadCodeAssist` (project id, cached for
the extension's life) then `retrieveUserQuotaSummary`.

* It answers **403** to a User-Agent not starting `antigravity`, which is why
  `Http` sets no session-wide agent and each provider passes its own.
* **The response says what is LEFT**; everything else here shows USED. Its own
  "Weekly Limit Remaining" label would lie over the inverted figure, so labels
  are built from window and model family. A parser check pins 0, 1 and 0.35.

## Verifying

* `make check` — all that needs no shell: ESLint, plus
  * `parsers`: each provider's parser over `tests/fixtures/`, including that
    unknown shapes degrade rather than throw. For Codex this is all there is.
  * `imports`: walks everything `prefs.js` reaches, fails on St, Clutter, Meta,
    Shell, Soup or `resource:///org/gnome/shell/`, then loads the shared modules.
  * `assets`: every shipped icon loads through gdk-pixbuf; every named icon exists.
* `make providers` — the real provider modules under plain `gjs`, printing what
  each button would show. Tells a data problem from a drawing problem.
* `./scripts/dev.sh nested` — a throwaway GNOME Shell with only this extension
  (a never-seen UUID cannot be enabled in a running Wayland session). Headless,
  or `--window`/`--keep`. Own D-Bus, keyfile GSettings under a scratch
  `XDG_CONFIG_HOME`; the live dconf is never opened. Runs what `make
  link`/`install` put in place.
* `./scripts/dev.sh shots [--light]` — the same shell, driven and photographed
  into `docs/screenshots/` (`--light`: top bar and pop-up only, `*-light.png`).

How shots work: `org.gnome.Shell.Screenshot` refuses all but a few known
callers, but on the throwaway bus `org.gnome.SettingsDaemon.MediaKeys` is
unclaimed, so `scripts/nested_driver.py` takes it. Input is a RemoteDesktop
session tied to a screencast, which puts a recording indicator in the top bar
until the driver exits — so a click and its photo are separate driver runs, and
the click coordinates in `nested.sh` are measured with the indicator present.

## Layout

`src/` is **exactly what ships**: `make pack` zips it and refuses a stray file.

```
src/extension.js        entry point: imports lib/app.js
src/prefs.js            preferences (own process); every row binds to a key
src/stylesheet.css      sizes taken from the shell's own theme; why, beside
                        each rule
src/schemas/            global schema + relocatable per-provider schema
src/icons/              the fallback gauge and one symbolic icon per provider
src/lib/app.js          when to read, which buttons exist and where they sit,
                        notifications, the desktop clock-format setting
src/lib/indicator.js    one panel button and its pop-up; draws the Reading it
                        is handed -- no polling, no settings, no providers
src/lib/usage.js        Limit, Reading, Status, Severity and their wording;
                        no shell imports, so scripts/ can load it
src/lib/settings.js     per-provider settings, capabilities -> switches, and
                        applyOptions(). Imports only Gio and usage.js (prefs)
src/lib/http.js         one libsoup session; getJson/postJson; HttpError(status)
src/lib/log.js          debug (verbose only) / warn / error, "[AI Usage]" prefix
src/lib/providers/registry.js     which providers exist; the provider contract
src/lib/providers/common.js       detect, reading, readText, parseTimestamp,
                                  failureReading, unknownShapeReading
src/lib/providers/claude.js       Claude, via Claude Code's stored login
src/lib/providers/antigravity.js  Antigravity, via agy's keyring login
src/lib/providers/codex.js        Codex -- written from openai/codex, NEVER RUN
```

`scripts/dev.sh` is the front door (`make` delegates). `scripts/dev-extension.js`
replaces `src/extension.js` in a `make link` install so edits reload without a
shell restart. `make install` copies and cannot reload: the shell keeps the JS it
first imported until you log out.

## How it behaves

* **One button per live provider** (`enabled` and its CLI on `PATH`), always:
  a percentage must sit beside an icon naming its subscription. `_syncButtons()`
  diffs against the live list, so toggling needs no restart. Role
  `${uuid}-${providerId}`; placed in `panel-box` from `panel-index`, in registry
  order. The icon (`icons/<provider.icon>.svg`, else `ai-usage-symbolic.svg`) is
  always drawn at 16px; `show-percent` only hides the figure.
* **Reading is lazy.** A timer (`poll-seconds`) is the fallback, skipped when
  the session has been idle for 10 minutes. The real triggers are the stored
  login changing on disk (file monitor, 2 s debounce) and opening a pop-up —
  which re-reads only if the figures are over a minute old. Header refresh
  always reads, every provider.
* Notifications fire once per limit per window, keyed by reset time (rounded to
  the minute by `parseTimestamp()`); the set is module scope in `app.js` so
  lock/unlock does not repeat them.
* The pop-up copies Claude Code's `/usage`: name (the one expanding column),
  dimmed reset, percentage in a fixed `min-width` cell, bar underneath. Refresh
  and preferences are the shell's `icon-button flat` at the header's right end,
  dimmed on the icon (not the button, or the hover background dims too) and lit
  on hover/focus by `actionButton()`. The empty state still gets a header.
* `reset-format` words resets in pop-ups and notifications alike, through
  `formatReset()` on the desktop's `clock-format`; `auto` matches Claude Code.
  Claude's labels (`5-hour limit`, `Weekly · all models`) and plan format
  (`Max (20x)`) live in `claude.js`. The breakdown line shows only when two or
  more surfaces are above zero (`formatBreakdown()`).

## Settings

Global keys: `primary-limit` (`session` default, `highest`, `weekly`),
`show-percent`, `reset-format`, `panel-box`, `panel-index`, `poll-seconds`,
`warn-percent`, `critical-percent`, `notify-percent`.

**Per-provider keys are a relocatable schema** at
`/org/gnome/shell/extensions/ai-usage/providers/<id>/` (no schema change per
provider): `enabled`, `show-per-model`, `show-breakdown`, `show-credits`. The
provider's `capabilities` (`perModel`, `breakdown`, `credits`) decide which
switches the preferences offer (`keysFor()`).

**`applyOptions(reading, options, thresholds)` in `settings.js` is the one
place** switches and thresholds are applied; providers return everything, and
the renderer reads no settings. It returns a view without mutating the Reading,
so any display change is one redraw and no request. Only `enabled` re-reads.

## Adding a provider

1. Find the request the CLI makes for its own usage command (`strings` over the
   binary, grepped for `usage`/`limit`, is how `/api/oauth/usage` was found),
   and where the tool stores its login.
2. Write `src/lib/providers/<id>.js` mapping the response onto `Limit`s, with
   `capabilities` and optionally `icon` (`src/icons/<name>.svg`), using
   `common.js` for detection, Readings, file reads, timestamps and failures.
   Contract: never throw (return a `Reading` with a `Status`), never write to the
   provider's files, never log in, and pull nothing of St, Clutter or Soup into
   the prefs process — read `e.status` duck-typed, as `failureReading()` does.
   `make imports` enforces the last.
3. Register it in `registry.js`; preferences, settings and `make providers`
   follow. Add a fixture under `tests/fixtures/` and checks in `scripts/parsers.js`.

## Gotchas

* **An icon must have `<svg` in its opening bytes.** gdk-pixbuf sniffs the
  start, so a licence comment before the tag makes it silently not an image.
  Put comments inside the `<svg>`. `make assets` holds this.
* **`St.Bin` centres its single child and ignores the child's `x_align`.** Use
  `St.BoxLayout`, which hands an `x_expand` child the slack and then aligns it.
  The bar fills and the percentage figures both floated mid-cell because of it.
* **St has no `:last-child`/`:first-child`.** The last pop-up row is marked
  `ai-usage-last` by `_padLastRow()` in `indicator.js`.
* **St has no CSS `opacity` and no percentage widths.** Dim with actor opacity
  (`DIM_OPACITY` in `indicator.js`); the bar fill is sized against its track on
  `notify::width`. `min-width` does exist.
* **No negative margins.** St passes a negative preferred width up the tree;
  the shell logs `tried to allocate a size of -2147483648` and the pop-up opens
  empty, which looks like the menu failing to open.
* **Menus follow the light/dark preference**, so no foreground colour is
  hardcoded. The only flat colours are the bar track's mid grey and GNOME's
  warning/critical palette. `-st-accent-color` follows a plain-blue fallback
  declaration, which an older shell keeps.
* `PanelMenu.Button` defines `_init`, so `UsageIndicator` uses `_init`.
  `UsageBar` extends `St.BoxLayout`, which does not, so it uses
  `constructor`/`super`.
* `addToStatusArea` claims a role for the life of the indicator, so it cannot
  move one: a move is a reparent into the panel's box. Destroying the indicator
  releases the role, which is why a provider can be toggled without a restart.
* `gjs -m -c "import('...')"` fails for any input on gjs 1.88; use a script.
