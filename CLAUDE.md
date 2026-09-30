# AI Usage

A GNOME Shell extension (UUID `ai-usage@jackicus`) that puts a button in the top
bar showing how much of an AI subscription's rate limits have been used — the
current session, the week, and the week per model — with the time each resets.
GJS, ES modules, `metadata.json` claims shell 50.

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

The drawing itself needs a real shell. A never-before-seen UUID cannot be
enabled in a running Wayland session, so the first run needs a log out and back
in, or a nested shell. **There is no `nested.sh` here yet** — porting the one in
`GNOME-Media-Controls` is the outstanding piece; about a third of it is VLC and
gamepad specific and does not apply.

## Layout

`src/` is **exactly what ships**: `make pack` zips it and refuses a stray file.

```
src/extension.js          the shipped entry point: imports lib/app.js
src/lib/app.js            when to read, where the button sits, what settings mean
src/lib/indicator.js      the panel button and the pop-up; renders Readings and
                          nothing else -- no polling, no provider knowledge
src/lib/usage.js          Limit, Reading, Status, Severity and their wording.
                          Deliberately free of the shell's imports so that
                          scripts/providers.js can import it outside the shell
src/lib/http.js           one libsoup session; GET returning parsed JSON
src/lib/settings.js       the per-provider relocatable schema, and which
                          switches a provider's capabilities justify. Imports
                          nothing but Gio, so prefs.js can load it
src/lib/providers/registry.js  which providers exist, and how to add one
src/lib/providers/claude.js    Claude, via Claude Code's stored login
src/lib/providers/codex.js     Codex, via the Codex CLI's stored login --
                               written from openai/codex's source, NEVER RUN
src/icons/                a gauge, shipped because Adwaita has no reliable one
src/prefs.js              preferences; every row binds straight to a key
```

`scripts/dev.sh` is the front door for everything (`make` only delegates).
`scripts/dev-extension.js` replaces `src/extension.js` in a `make link` install
so edits reload without restarting the shell; its staging walk is **recursive**,
unlike the Media Controls one, because `lib/providers/` exists.

## Settings

Global settings are the ordinary schema. **Per-provider settings are a
relocatable schema** instantiated at
`/org/gnome/shell/extensions/ai-usage/providers/<id>/`, so adding a provider
needs no schema change: `enabled`, `show-in-panel`, `show-per-model`,
`show-breakdown`, `show-credits`.

A provider declares a `capabilities` object, and the preferences offer only the
switches it can honour — a provider with no per-model limits is never offered a
per-model switch. The switches are applied in **one place**, `applyOptions()` in
`app.js`: providers always return everything they know, and the renderer reads
no settings at all. Turning a row off therefore costs no request — `_redraw()`
re-applies the switches to figures already in hand.

`prefs.js` runs in its own process and can only load modules clear of St and of
`resource://` paths. The registry and `settings.js` are deliberately kept that
way — `claude.js` reads `e.status` duck-typed rather than importing `HttpError`,
precisely so that Soup stays out of that import graph — so the preferences build
their provider list from the **real** registry rather than a copy kept in step
by hand. If you add an import to a provider module, check it still loads:

```sh
gjs -m -c "import('./src/lib/providers/registry.js')"
```

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
* `addToStatusArea` is the only way to move the button, so a move is a remove
  and an add of the same actor.
