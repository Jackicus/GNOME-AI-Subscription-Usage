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

Each provider's endpoint, its traps and how to add one are in
`.claude/rules/providers.md`; the provider contract is the header of
`src/lib/providers/registry.js`.

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
src/lib/providers/registry.js     which providers exist; the provider contract
src/lib/providers/common.js       detect, reading, readText, parseTimestamp,
                                  failureReading, unknownShapeReading
src/lib/providers/claude.js       Claude, via Claude Code's stored login
src/lib/providers/antigravity.js  Antigravity, via agy's keyring login
src/lib/providers/codex.js        Codex -- written from openai/codex, NEVER RUN
tests/fixtures/         one saved response per provider, for `make parsers`
```

`make pack` also refuses a zip holding any file it did not expect (`check_pack`
in `./scripts/dev.sh`). `./scripts/dev-extension.js`, the `make link` entry
point, also turns the debug log on.

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
  the minute by `parseTimestamp()`); the set is module scope in `app.js` so
  lock/unlock does not repeat them.
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

* `make check` — all that needs no shell, and what CI runs: ESLint, plus
  * `schemas`: `glib-compile-schemas --strict --dry-run src/schemas`.
  * `parsers`: each provider's parser over `tests/fixtures/`, including that
    unknown shapes degrade rather than throw. For Codex this is all there is.
  * `imports`: walks everything `prefs.js` reaches, fails on St, Clutter, Meta,
    Shell, Soup or `resource:///org/gnome/shell/`, then loads the shared modules.
  * `assets`: every shipped icon loads through gdk-pixbuf; every named icon exists.

  CI adds `libsecret` (`.github/ci-packages`): `antigravity.js` imports
  `gi://Secret`, and the imports and parsers checks load it.
* `make providers` — the real provider modules under plain `gjs`, printing what
  each button would show. Tells a data problem from a drawing problem. It reads
  the real stored logins and goes to the network: ask first.

### The throwaway shell

This repository has no `./scripts/nested.sh start/stop`; it has these, which
take the place of the kit's loop (`gnome-ext:nested-shell` still holds for what
to look at and what never to touch):

* `./scripts/dev.sh nested` — a throwaway GNOME Shell with only this extension
  enabled. Headless, or `--window`/`--keep`. Own D-Bus, keyfile GSettings under
  a scratch `XDG_CONFIG_HOME` (`$XDG_RUNTIME_DIR/ai-usage-nested/`), so the live
  dconf is never opened: there is no `--clean` because there is nothing to
  isolate. It lives only as long as the command (`--keep`, `--window`: until
  Ctrl+C), so there is no `stop` and no SessionEnd hook. Runs what `make
  link`/`install` put in place. A setting is tried by appending it to the
  keyfile (`nested.sh`'s header says how).
* `./scripts/dev.sh shots [--light]` — the same shell, driven and photographed
  into `docs/screenshots/` (`--light`: top bar and pop-up only, `*-light.png`).
  It photographs a stand-in world, since the pictures are public: inside its
  own user and mount namespace, stand-in `claude` and `agy` overlaid on
  `/usr/bin` with `PATH` system-only, a scratch `HOME` with stand-in logins, and
  this checkout's `src/` staged there with `./scripts/stand-in-http.js` over
  `lib/http.js`, which answers with invented figures. No real path, login,
  account or network reaches a shot; a provider added without an answer there
  shows as unavailable. Plain `nested` still runs your install and logins.
  It ends by stripping the PNGs' text chunks with `oxipng` (it warns when
  `oxipng` is missing, and the shots must not be committed until stripped).

Input is a RemoteDesktop session whose recording indicator stays in the top
bar until the driver exits, so a click and its photo are separate driver runs,
and the click coordinates in `nested.sh` (`CLAUDE_BUTTON`, `TAB_*`) are
measured with the indicator present. Antigravity's keyring lookup times out on
the throwaway bus after about 25 s (`SETTLE_SECONDS`); under `shots` it then
falls back to the stand-in token file, and under plain `nested` its button
shows amber with no figure.
