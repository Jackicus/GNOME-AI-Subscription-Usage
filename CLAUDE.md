# AI Usage

A GNOME Shell extension (UUID `ai-usage@jackicus`) that puts a button in the top
bar per AI subscription, showing how much of its rate limits have been used —
the current session, the week, and the week per model — with the time each
resets. GJS, ES modules, `metadata.json` claims shell 50.

The name is plural on purpose: the architecture is multi-provider, and Claude is
the first. Only Claude ships today, because it is the only one whose tool is
installed here to verify against.

## The rule the whole design hangs off

**This extension never signs anyone in.** It reads the login that a provider's
own command-line tool has already stored, and does nothing else with it. So:

* The provider's CLI is a hard requirement. A provider whose command is not on
  `PATH` is left out of the pop-up entirely, not shown as broken.
* The extension never refreshes a token. For Claude, refreshing rotates the
  refresh token, so doing it here could leave Claude Code holding a spent one
  and sign the user out of their terminal. When a token is rejected the button
  says so and asks the user to run the tool once, which refreshes it as a side
  effect of starting.
* Tokens are read fresh on every poll and never held between them — the tool
  rewrites the file when it refreshes, so a cached token is a stale one.
* Nothing is ever written to a provider's files, and no token is logged at any
  verbosity.

## Where the numbers come from

`GET https://api.anthropic.com/api/oauth/usage`, with the OAuth access token
from `~/.claude/.credentials.json` and the header
`anthropic-beta: oauth-2025-04-20`. That is the request Claude Code's own
`/usage` makes, which is the point: the button agrees with the terminal because
it is not a second reckoning of anything.

The beta header is **not** currently required — the endpoint answers without it
— but it is sent regardless, so that this looks exactly like the tool whose
login it is borrowing. A rejected token gets a 401, which is what maps to
`Status.EXPIRED`; both were checked against the live endpoint.

The useful part of the response is `limits[]` — one row per limit, each with a
`percent`, a `severity`, a `resets_at` and an `is_active`, plus a `scope.model`
on the per-model rows. `seven_day_breakdown` says where the week went, and
`extra_usage`/`spend` cover paid-for credits. The older top-level `five_hour`
and `seven_day` objects carry the same figures with less metadata and are kept
as a fallback.

The plan name is not in that response, and it is **not** the `rateLimitTier` in
the credentials either: that one is stamped in at sign-in and never rewritten,
so an upgraded account keeps reporting the plan it signed up on. It comes from
`~/.claude.json` → `oauthAccount.organizationRateLimitTier` (then
`userRateLimitTier`), which Claude Code refreshes when it starts — a second
file read, deliberately not a second request, so the poll stays one HTTP call.
That file is large and full of things this extension has no business with, so
only the tier is taken from it and nothing is kept; absent, half-written or
without an `oauthAccount` all fall back to the credentials tier and then to
`subscriptionType`, because a missing plan name is fine and a wrong one is not.

**This endpoint is undocumented and its shape moves.** The response has fields
named `iguana_necktie`, `nimbus_quill`, `brass_thimble` — unreleased things
behind codenames. So `claude.js` reads defensively and reports
`Status.UNAVAILABLE` rather than throwing or showing a wrong number. `limits[]`
is treated as the service's own curated list: an unrecognised `kind` in it is
shown under a label made from its name, while the top-level codenames are never
touched.

## Seeing it

`make check` is everything that can be verified without a shell: ESLint, plus
`./scripts/dev.sh parsers`, which runs each provider's parser over a fixture in
`tests/fixtures/` and checks the result. **For a provider whose tool is not
installed, that fixture is the only thing standing behind it** — the Codex
parser has never seen a live response. Both parsers are also checked to degrade
rather than throw on a shape they do not know, since a provider that throws
takes the whole pop-up with it.

`./scripts/dev.sh providers` runs the extension's **own provider modules** under
plain `gjs` and prints what the button would show — CLI found, login stored,
figures. It is the fastest way to tell a data problem from a drawing problem,
and because it imports `src/lib/` rather than a copy, agreeing with the button is
not a coincidence.

The drawing itself needs a real shell, and a never-before-seen UUID cannot be
enabled in a running Wayland session. `./scripts/dev.sh nested` is the way round
that: a throwaway GNOME Shell with only this extension enabled, headless by
default and `--window` to actually look at it. It writes nothing of the live
session's — its settings come from the keyfile GSettings backend under a scratch
`XDG_CONFIG_HOME`, so dconf is never opened — and it prints the extension's own
state and log lines, which is how "2 button(s) — claude, antigravity" was first
seen to be true rather than assumed.

Headless used to prove only that it loads. `./scripts/dev.sh shots` starts the
same throwaway shell, **works its controls and photographs it** into
`docs/screenshots/` — the top bar, a button's pop-up open, and each page of the
preferences.

The whole thing turns on one refusal and how to get round it. The shell will not
screenshot for just anyone: `org.gnome.Shell.Screenshot` answers "Screenshot is
not allowed" unless the caller is one of a few known services, and there is no
other public API. But the throwaway shell has a bus of its own, and on that bus
the name `org.gnome.SettingsDaemon.MediaKeys` is unclaimed — so
`scripts/nested_driver.py` takes it, and is then a caller the shell will serve.
That is the whole difference between this and every naive attempt. Input is the
same driver: a `org.gnome.Mutter.RemoteDesktop` session, linked to a screencast
purely so that pointer motion may be absolute rather than relative.

Two things follow from that screencast, and the recipe in `nested.sh` is shaped
by both. The shell puts a **recording indicator** in the top bar while it runs,
which both lies about the extension and shoves every button along the bar; and
the indicator only goes when the process that asked for one has exited. So a
click and the photograph of what it opened are **separate runs of the driver**,
and the coordinates a click uses are the ones measured with the indicator there.
They are measured, because the shell will not say where an actor is: `--keep`
leaves the shell up and prints the command to take a `shot` and look again.

Both of the other two pieces come from the family: the driver is
GNOME-Media-Controls' `nested_driver.py`, minus the screencast-mirror half that
this project has no window for.

## Layout

`src/` is **exactly what ships**: `make pack` zips it and refuses a stray file.

```
src/extension.js          the shipped entry point: imports lib/app.js
src/lib/app.js            when to read, which buttons exist and where they sit,
                          what the settings mean
src/lib/indicator.js      one panel button and its pop-up; renders the Readings
                          it is handed and nothing else -- no polling, no
                          provider knowledge, and no idea how many buttons
                          there are
src/lib/usage.js          Limit, Reading, Status, Severity and their wording.
                          Deliberately free of the shell's imports so that
                          scripts/providers.js can import it outside the shell
src/lib/http.js           one libsoup session; GET returning parsed JSON
src/lib/settings.js       the per-provider relocatable schema, the two panel
                          modes, and which switches a provider's capabilities
                          and the current mode justify. Imports nothing but
                          Gio, so prefs.js can load it
src/lib/providers/registry.js  which providers exist, and how to add one
src/lib/providers/claude.js    Claude, via Claude Code's stored login
src/lib/providers/codex.js     Codex, via the Codex CLI's stored login --
                               written from openai/codex's source, NEVER RUN
src/lib/providers/antigravity.js  Antigravity, via agy's keyring login
src/icons/                the gauge, shipped because Adwaita has no reliable
                          one; each button resolves its provider's own icon
                          here and falls back to the gauge
src/prefs.js              preferences; every row binds straight to a key
```

`scripts/dev.sh` is the front door for everything (`make` only delegates).
`scripts/dev-extension.js` replaces `src/extension.js` in a `make link` install
so edits reload without restarting the shell; its staging walk is **recursive**,
unlike the Media Controls one, because `lib/providers/` exists.
`scripts/nested.sh` owns the throwaway shell and holds the shots recipe — which
steps, which coordinates, which files; `scripts/nested_driver.py` is the
screenshot and input driver it calls, and knows nothing about this extension.

## The other two providers

**Antigravity** (`agy`) keeps its login in the **secret service**, not a file.
The file beside it, `~/.gemini/antigravity-cli/antigravity-oauth-token`, is only
written when there is no D-Bus session, and on an ordinary desktop it is stale —
on the machine this was written on it was 17 days old while the keyring entry was
minutes old. Reading the file first would serve a dead token on a healthy
machine, so the keyring is tried first and the file only after.

Its figures take two POSTs to `cloudcode-pa.googleapis.com`: `loadCodeAssist`
names the project the quota hangs off, then `retrieveUserQuotaSummary` returns
the buckets. The project id is kept for the life of the extension, so later
polls make one request. Two traps:

* the service answers **403** to a User-Agent that does not begin with
  `antigravity`. That is why `Http` sets no session-wide agent and each provider
  passes its own.
* **the response says what is LEFT.** Everything else here shows what is USED,
  and each bucket's own `displayName` is "Weekly Limit Remaining" — so reusing
  that label over an inverted figure would be a plain lie. The label is built
  from the window and the model family instead, and there is a parser check
  pinning all three of 0, 1 and 0.35.

**Codex** has never run; see the header of its own file.

## Settings

Global settings are the ordinary schema. **Per-provider settings are a
relocatable schema** instantiated at
`/org/gnome/shell/extensions/ai-usage/providers/<id>/`, so adding a provider
needs no schema change: `enabled`, `show-in-panel`, `show-per-model`,
`show-breakdown`, `show-credits`.

A provider declares a `capabilities` object, and the preferences offer only the
switches it can honour — a provider with no per-model limits is never offered a
per-model switch. The switches are applied in **one place**, `applyOptions()` in
`settings.js`: providers always return everything they know, and the renderer
reads no settings at all. Turning a row off therefore costs no request —
`_redraw()` re-applies the switches to figures already in hand.

### The two panel modes

`panel-mode` decides how many buttons there are, and it is the one setting that
changes what another setting *means*:

* **`per-provider`** (the default) — one button per live provider, each with
  that provider's own icon, its own figure and its own pop-up. A percentage
  belongs to a subscription, so it has to sit beside something that names the
  subscription; a single unlabelled figure would switch from one to another the
  moment the second overtook the first.
* **`combined`** — the older single button, carrying whichever provider is
  closest to its limit and listing them all in one pop-up.

`show-in-panel` says which providers may supply that one shared figure, so it
means nothing in `per-provider` mode. It is not read there at all:
`displayOptions(settings, mode)` returns `showInPanel: true` outside `combined`,
because a switch left off from a spell in the other mode would otherwise take a
whole button away. The preferences leave the row visible but insensitive in
`per-provider` mode, so the window does not jump as the mode changes.

Both modes are the same machinery in `app.js`: a map of buttons keyed by
provider id (or by one constant for the combined button), each holding the
provider ids whose readings it draws. `_syncButtons()` diffs what is on screen
against what the mode and the live provider list call for, so switching a
provider — or the whole mode — takes effect with no shell restart. A button's
panel role is claimed for the life of its indicator, so the role is
`${uuid}-${providerId}` per provider (the plain `uuid` for the combined one),
and a *move* is still a reparent rather than a second `addToStatusArea`.
`panel-box` and `panel-index` stay global: the buttons go in the chosen box,
adjacent, in registry order from that index.

Each button's icon is `provider.icon` resolved to `icons/<name>.svg`, falling
back to `icons/ai-usage-symbolic.svg` when the property is absent or the file is
not there — so a provider with no icon of its own still gets a button.

`prefs.js` runs in its own process and can only load modules clear of St and of
`resource://` paths. The registry and `settings.js` are deliberately kept that
way — `claude.js` reads `e.status` duck-typed rather than importing `HttpError`,
precisely so that Soup stays out of that import graph — so the preferences build
their provider list from the **real** registry rather than a copy kept in step
by hand. `make imports` holds that rule: it walks everything `prefs.js` reaches
and fails on an import of St, Clutter, Meta, Shell or Soup, then loads the two
shared modules outside the shell to prove it rather than infer it. It is part of
`make check`, so adding an import to a provider module says so at once.

(`gjs -m -c "import('...')"` is what this used to say, and it does not work: on
gjs 1.88 `-m -c` resolves the snippet against a `<command line>` path that does
not exist, and fails for any input at all.)

## Adding a provider

1. Find the request the provider's CLI makes for its own usage command.
   `strings` over the installed binary, grepped for `usage` or `limit`, is how
   `/api/oauth/usage` was found for Claude.
2. Find where that tool stores the login it made at sign-in.
3. Write `src/lib/providers/<id>.js` mapping the response onto `Limit` objects,
   and declare its `capabilities`. The contract: never throw (return a `Reading`
   carrying a `Status` instead), never write to the provider's files, never
   perform a login, and import nothing that would pull St or Soup into the prefs
   process.
4. Register it in `registry.js`. Nothing else needs touching: the preferences,
   the per-provider settings and `make providers` all pick it up from there.

## Gotchas

* **St has no CSS `opacity` and no percentage widths.** Secondary text is dimmed
  with actor opacity from `indicator.js`; the bar fill is sized against the
  track's allocation on `notify::width`.
* **Menus follow the light/dark preference**, so no foreground colour is
  hardcoded. The one flat colour needed — the empty part of a bar — is a mid
  grey that sits correctly on either.
* `-st-accent-color` is used for the bar with a plain blue declared before it:
  a shell that does not know the value drops that declaration and keeps the
  fallback.
* `PanelMenu.Button` defines `_init`, so `UsageIndicator` must use `_init` too.
  `UsageBar` extends `St.Bin`, which does not, so it takes the modern
  `constructor`/`super` form — which is also what the lint rules want.
* `addToStatusArea` claims a role for the life of the indicator, so it cannot
  also be used to move one: a move is a remove and an add of the same actor,
  straight into the panel's box. Destroying an indicator is what releases its
  role, which is why a provider can be switched off and on again without a
  restart.
