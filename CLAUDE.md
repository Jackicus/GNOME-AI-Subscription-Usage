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

`shots --light` is the same run with the throwaway shell set to the light
preference, which is one line in that keyfile because nothing else reads it. It
photographs the top bar and the pop-up only — the preferences are a GTK window
and follow their own colour setting rather than the shell's — and names those
two `*-light.png`, so the pair in `docs/screenshots/` is the proof that not
hardcoding a foreground colour actually pays off rather than the claim that it
does.

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
`_redraw()` re-applies the switches to figures already in hand. The colour
thresholds go the same way: a provider keeps only the severity the service
itself reported, and `applyOptions()` lays `warn-percent`/`critical-percent`
over it, so moving one recolours the figures without asking for them again.

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

What a button is made of is one more global key, `show-percent`: the icon is
always there, at the shell's own 16px (`ICON_SIZE` in `indicator.js`), because in
`per-provider` mode it is the thing that says whose figure this is. With the
figure off a button is its icon alone, tinted by how much has been used — which
is why there is no switch for the icon, and so no way to end up with a button of
no width and nothing to see.

### The pop-up

It is laid out the way Claude Code's own `/usage` panel is, because these are
Claude Code's figures and a second opinion is exactly what this is not meant to
look like. One row per limit: the name hard left, the reset dimmed and
right-aligned beside it, the percentage hard right, and a bar under all three.

**Every size in `stylesheet.css` is a number out of the shell's own theme**,
read from `gnome-shell-theme.gresource` rather than judged by eye, because the
thing this pop-up sits next to is Quick Settings and the only way to agree with
it is to use its figures. The width is a Quick Settings panel's — two 12em
tiles, 12px between, 18px either side, so a little over 27em, set on
`menu.box`. The rows are `.popup-menu-item`'s own `padding: 9px 12px` and its
6px `spacing`. The bar is `.slider`'s `-barlevel-height: 4px` with
`border-radius: 999px` on the track and the fill, which is how the shell writes
"a pill" everywhere. Round ends put a floor under `UsageBar._resize()`'s
minimum sliver: a fill narrower than the bar is tall is a circle with its sides
cut off, so the floor is the height, at which 1% is a dot and 0% is nothing.
The margin is even all four ways round, and that one is settled off the picture
rather than by adding the numbers up. The sides are `.popup-menu-content`'s 6px
plus 12px of row padding — 18px, exactly what `.quick-settings` puts round
itself — which measures as 19px of white to the first ink. The bottom matches
it: the last row takes `padding-bottom: 12px`, and since **St has no
`:last-child`** the last row is whichever one `_padLastRow()` marked with
`ai-usage-last`, because it is not always a limit row and a caption's padding is
not a limit's. The top is 9px and not 12px, which looks wrong written down and
is right on screen: the header's first line carries 3px of leading above its cap
height, while a bar is solid to its own edge, so 9px of padding and 12px of
padding measure the same 19px. (Before this, the top measured 22px against the
bottom's 16px — #36.)

The button's own padding is from the same place: the shell's
`-natural-hpadding` is 12px, which around an icon and two digits leaves the
button detached from its own figure, so it takes the shell's other figure,
`-minimum-hpadding: 6px`. `.system-status-icon`'s 6px of padding goes too —
that is the shell sizing a button that is an icon alone, and it was holding the
icon apart from the percentage beside it; the shell zeroes it for the same
reason in `.panel-status-indicators-box`.

Three columns line up between rows only if they are made to. **Exactly one
column expands** — the name — so it absorbs all the slack, and the percentage
sits in a cell with a `min-width` of its own with the figure aligned to the end
of it. That fixes the right edge of the figures and, because the cell is a fixed
size, the reset column's right edge as well. The width is in `em`, so it still
holds `100%` on a desktop with the text scaled up.

That cell is an `St.BoxLayout`, for the same reason `UsageBar` is: **an
`St.Bin` centres its single child and ignores the child's `x_align`**. As a bin
it drew every figure in the middle of its 3.5em cell — 12px short of where the
bar under it ended, which looked plausible and was wrong, and is the same bug
that once made the bar fills float in the middle of their tracks (df9ae2d). In
a box the expanding child is handed the slack and *then* aligned inside it, so
`END` means the end, and the figures' right edge now measures the same 19px
inset as the bars' (#36).

Every limit's name is bold. Weight used to mean "the limit in force", which
Claude Code's own panel does not distinguish either, and which made two of the
three names read as less important rather than one as current. `Limit.active`
stays in the model — `app.js` reads it, and `make providers` still prints "in
force" — it simply no longer changes how a row is drawn.

The two actions — refresh, and an arrow to the preferences — sit at the
**right-hand end of the header row**, level with the provider's name and the
plan. That is where Claude Code's own usage panel puts its `→` and where Quick
Settings puts the one at the end of a slider, and it is what makes them free:
the row was already there, so they cost no height at all (the footer they came
out of cost 61px). They take the shell's **own** `icon-button flat` pair of
classes, so the colours, the hover, the focus ring, `:insensitive` and
`:checked` all come from the theme and go on coming from it when the theme
changes, and `flat` is what makes the resting background the menu's own — no
filled circle until the glyph is pointed at. Each carries an `accessible_name`,
which matters more now than it did: an arrow and a circular arrow say nothing to
a screen reader, and there is no longer even a filled shape to aim at. The one
thing the stylesheet repeats is the padding, which that class gets from its
surroundings rather than from itself — 6px across, from `.quick-slider`, and 2px
down, so the button is exactly as tall as the header's own text and the row does
not grow to hold it. The glyphs are `icon-size: 0.955em` — 14px where
`.icon-button StIcon` is 1.091em, so 16px — because they are furniture and not
the subject; `.icon-button`'s `min-height` is unchanged, so the row is the same
height it was.

Drawn at full strength they were the brightest thing in the pop-up, brighter
than the figures it is for, so they are dimmed to `DIM_OPACITY` like every other
piece of secondary furniture here. **The opacity goes on the icon, not on the
button**: opacity multiplies down the tree, so dimming the button would take the
theme's hover background down with the glyph. And the theme will not bring the
glyph back on its own — `.icon-button.flat:hover` sets only `background-color`,
the colour is `#ffffff` either way, and no CSS colour can undo an actor's
opacity — so `actionButton()` wires the hover and the key focus itself. Measured
off the pictures: 255 before, 182 at rest, 255 again under the pointer while its
neighbour stays at 181.

**They belong to the pop-up, not to a provider**: refresh reads every live
provider and there is one preferences window. In `per-provider` mode each pop-up
has one header and the distinction is invisible; in `combined` mode there are
several, and `indicator.js` draws the actions on the **first header only**. The
empty state — nothing read yet, or no provider switched on — gets a header of
its own to carry them, since a pop-up with no way to the preferences is a dead
end exactly where someone needs it.

Whether an action closes the pop-up is the action's own and stays in `app.js` —
a refresh leaves it open, because the point is watching the figures change; the
preferences close it, because a window is about to cover it.

A negative margin is not the way to pull that arrow out flush with the
percentages below it. St hands a negative preferred width straight up the tree:
the shell logs `tried to allocate a size of -2147483648`, and the pop-up opens
with nothing drawn in it — which looks exactly like the button failing to open a
menu at all.

`reset-format` decides the wording, in the pop-ups and the notifications alike —
they are the same sentence, from the same `formatReset()`. `auto` is the default
because it is what Claude Code does: a countdown under a day (`Resets in 1 hr 1
min`), a weekday and wall-clock time beyond it (`Resets Tue 3:00 PM`), in the
user's own timezone and on the clock `org.gnome.desktop.interface clock-format`
says the desktop is set to, falling back to 24-hour. `relative`, `absolute` and
`both` are the three fixed choices. The function takes `now`, `clock` and
`timezone` for the parser checks alone; nothing that ships passes them.

Claude Code's row labels (`5-hour limit`, `Weekly · all models`, `Weekly ·
Fable`) and its plan format (`Max (20x)`) are **Claude's**, so they live in
`claude.js`; the other providers keep their own words.

The breakdown line is worded so it cannot be read as a limit, and shows only
when two or more surfaces are above zero — a single row is 100% by definition
and reports nothing. That rule is `formatBreakdown()` in `usage.js`, called by
the renderer: providers go on reporting every row they know, as the rest of them
do.

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

* **An icon must have `<svg` in its opening bytes.** gdk-pixbuf identifies a
  file by sniffing the start of it, so a licence comment before the tag makes
  the icon unrecognisable as an image — it renders fine in a browser, ships
  fine, and simply does not appear. Every icon here therefore opens with the
  declaration and the `<svg` element, and carries its comment *inside*. `make
  assets` holds the rule, because the only other symptom is a button with
  nothing beside the percentage.
* **St has no CSS `opacity` and no percentage widths.** Secondary text is dimmed
  with actor opacity from `indicator.js`; the bar fill is sized against the
  track's allocation on `notify::width`. It does have `min-width`, which is what
  holds the pop-up's percentage column still.
* **`St.Bin` centres its single child and ignores the child's `x_align`.** Both
  the bar fills and the percentage figures were drawn floating in the middle of
  their cells by it, and both look plausible enough to survive a glance — the
  figures were 12px short of the bars for a whole release. Use `St.BoxLayout`:
  a box packs from the start edge, and hands an `x_expand` child the slack and
  then aligns it inside that.
* **St has no `:last-child`** (nor `:first-child`). A rule meant for the last
  row has to be a class the code puts there — `_padLastRow()` in
  `indicator.js`.
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
