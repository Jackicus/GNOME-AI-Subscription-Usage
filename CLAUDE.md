# AI Usage

Shared rules for every extension come from the GNOME-EXTENSIONS kit: `../CLAUDE.md` and `../.claude/rules/` (loaded with this file), and the `gnome-ext:*` skills. `.claude/kit.sh` pulls the kit at session start, or, with no kit beside this repository, fetches it and prints its rules into the session.

A GNOME Shell extension (UUID `ai-usage@jackicus`, `version-name` 0.1, shell 50)
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

Each provider's endpoint, its traps, the provider contract and how to add one
are in `.claude/rules/providers.md`.

## Layout

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
src/lib/providers/registry.js     which providers exist
src/lib/providers/common.js       reading, readJson, humanise, parseTimestamp,
                                  failureReading, unknownShapeReading
src/lib/providers/claude.js       Claude, via Claude Code's stored login
src/lib/providers/antigravity.js  Antigravity, via agy's keyring login
src/lib/providers/codex.js        Codex -- written from openai/codex, NEVER RUN
tests/fixtures/         one saved response per provider, for `make parsers`
```

What ships is `./scripts/ext.conf`'s `EXT_SHIP` (`lib/` with `lib/providers/`,
and `icons/`); `make pack` refuses a zip holding anything else. The kit's
`./scripts/dev-extension.js`, the `make link` entry point, also turns the debug
log on (`lib/log.js`'s `setVerbose`) and names its stage after a checksum of
`lib/`'s files.

## How it behaves

* **One button per live provider** (`enabled` and its CLI on `PATH`), always:
  a percentage must sit beside an icon naming its subscription. `_syncButtons()`
  diffs against the live list, so toggling needs no restart. Role
  `${uuid}-${providerId}`; placed in `panel-box` from `panel-index`, in registry
  order. The icon (`icons/<provider.icon>.svg`, else `ai-usage-symbolic.svg`) is
  always drawn at 16px; `show-percent` only hides the figure.
* A move in `_placeButtons()` is a reparent into the panel's box, and a provider
  toggles without a restart because destroying its indicator releases the role.
* **Reading is lazy.** A timer (`poll-seconds`) is the fallback, skipped when
  the session has been idle for 10 minutes. The real triggers are the stored
  login changing on disk (file monitor, 2 s debounce) and opening a pop-up —
  which re-reads only if the figures are over a minute old. Header refresh
  always reads, every provider.
* Notifications fire once per limit per window, keyed by reset time (rounded to
  the minute by `parseTimestamp()`). The app holds that record, so a disable
  (a screen lock too) forgets it and a limit still past the line notifies once
  more after the unlock.
* `reset-format` words resets in pop-ups and notifications alike, through
  `formatReset()` on the desktop's `clock-format`; `auto` matches Claude Code.
  Claude's labels (`5-hour limit`, `Weekly · all models`) and plan format
  (`Max (20x)`) live in `claude.js`. The breakdown line shows only when two or
  more surfaces are above zero (`breakdownFrom()` in `claude.js` drops the
  zeros, `formatBreakdown()` wants two rows).
* How the pop-up is drawn, and its St workarounds: `.claude/rules/popup.md`.

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

## Private shell API

* `Main.panel._leftBox`, `_centerBox`, `_rightBox`, reached through `panelBox()`
  in `app.js`: the box a button is placed in and moved into. If they are
  renamed, `position()` throws on the first placement and no button appears.

## Verifying

* `make check` — all that needs no shell, and what CI runs: ESLint, the shared
  `schema` check (`--strict`), then `EXT_CHECKS`, each a `./scripts/dev.d/`
  command:
  * `parsers`: each provider's parser over `tests/fixtures/`, including that
    unknown shapes degrade rather than throw. For Codex this is all there is.
  * `imports`: walks everything `prefs.js` reaches, fails on St, Clutter, Meta,
    Shell, Soup or `resource:///org/gnome/shell/`, then loads the shared modules.
  * `assets`: every shipped icon loads through gdk-pixbuf; every named icon exists.

  CI adds `libsecret` (`.github/ci-packages`): `antigravity.js` imports
  `gi://Secret`, and the imports and parsers checks load it. It ends with `size`:
  src/ JavaScript against `EXT_BUDGET_LINES` (2900, today's size, provisional).
* `make providers` — the real provider modules under plain `gjs`, printing what
  each button would show. Tells a data problem from a drawing problem. It reads
  the real stored logins and goes to the network: ask first.

### The nested shell

The kit's `./scripts/nested.sh` (`gnome-ext:nested-shell`). What is this
extension's own:

* **A plain `start` runs your install, your CLIs and your logins**, so its
  providers read the real stored logins and go to the network. To try something
  without that, `start --stand-in`; to see a plain start come up with no
  provider live, start it with `PATH=/usr/local/bin:/usr/bin` (no CLI there).
* **`start --stand-in`** is a stand-in world (`./scripts/nested.d/stand-in.sh`):
  stand-in `claude` and `agy` overlaid on `/usr/bin` (`EXT_STAND_IN_BINS`), a
  scratch `HOME` with stand-in logins, and the staged copy's `lib/http.js`
  replaced by `./scripts/stand-in-http.js`, which answers with invented figures.
  No real path, login, account or network reaches it; a provider added without
  an answer there shows as unavailable. `reload` re-stages `src/` with
  `stand-in-http.js` (`nested_stand_in_stage`); the logins are made once per start.
* **`./scripts/nested.sh shots [--light] [--out DIR]`** (`make shots`) takes the
  published set into `docs/screenshots/` over `start --stand-in --headless`,
  then stops (`--light`: top bar and pop-up only, `*-light.png`; `--out`: the
  scratchpad, to compare before committing). It refuses while a nested shell
  runs. `--stand-in` starts in GNOME's stock look, so a shot carries none of
  your fonts or icon theme. It ends by stripping the PNGs' text chunks with `oxipng` (it warns when `oxipng` is missing; never
  commit them unstripped).

Input is a RemoteDesktop session whose recording indicator stays in the top
bar until the driver exits, so a click and its photo are separate `do` calls,
and the click coordinates in `./scripts/nested.d/shots.sh`
(`SHOTS_CLAUDE_BUTTON`, `SHOTS_TAB_*`) are measured with the indicator present.
Antigravity's keyring lookup times out on the nested bus after about 25 s
(`SHOTS_SETTLE`, and an expected "keyring lookup failed" log line); under
`--stand-in` it then falls back to the stand-in token file, and under a plain
start its button shows amber with no figure.
