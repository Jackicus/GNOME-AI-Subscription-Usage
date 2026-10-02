# Publishing to extensions.gnome.org

How the upload is built, what is in it, and how the code stands against the
extensions.gnome.org
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## The zip

A release is a pushed `v*` tag: the `Release` workflow runs `make check`, packs
`dist/ai-usage@jackicus.shell-extension.zip` with `./scripts/dev.sh pack` and
attaches it to the GitHub release. That zip is what is uploaded. It holds:

```
LICENSE  metadata.json  extension.js  prefs.js  stylesheet.css
schemas/org.gnome.shell.extensions.ai-usage.gschema.xml
icons/ai-usage-symbolic.svg
lib/app.js  lib/http.js  lib/indicator.js  lib/log.js  lib/settings.js  lib/usage.js
lib/providers/registry.js  lib/providers/common.js
lib/providers/claude.js  lib/providers/antigravity.js  lib/providers/codex.js
```

`make pack` refuses a zip holding anything else, and drops a compiled schema
(the shell compiles it on install).

## metadata.json

| Key | Now | Note |
|---|---|---|
| `uuid` | `ai-usage@jackicus` | Fixed once uploaded |
| `shell-version` | `["50"]` | The only version it has run on |
| `settings-schema` | set | `getSettings()` with no argument in `app.js` and `prefs.js` |
| `version-name` | `0.1` | Letters, digits, dots and spaces, at most 16 |
| `version` | absent | extensions.gnome.org assigns it |
| `session-modes` | absent | `user` only: a screen lock disables it |
| `description` | three paragraphs | Names the providers, that each needs its own CLI signed in, that the login is sent only to that provider's server, and that it never signs anyone in |
| `url` | GitHub repository | Set |

## The review guidelines, checked against this code

Checked on 2026-10-02, before the 0.1 release, against the
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html)
as published that day, on the zip `make pack` builds, and in a nested GNOME
Shell 50 against a live Codex login (button, pop-up, reload, no errors in the
log). No blockers.

**Nothing before `enable()`: meets.** `extension.js` builds `AiUsageApp` in
`enable()`; its constructor runs there too. Module scope holds constants, the
`UsageIndicator` class registration and two `Gio._promisify` calls.

**`disable()` undoes `enable()`: meets.** `AiUsageApp.disable()`
(`src/lib/app.js`) removes the poll timer and the debounce source, cancels a
read in flight, disconnects the extension's, the desktop interface's and each
provider's settings, destroys every button, cancels the login file monitors
and aborts the HTTP session. Each pop-up's widgets go with its button.

**Imports: meets.** No `ByteArray`, `Lang` or `Mainloop`. The shell side
imports no `Gdk`, `Gtk` or `Adw`. `prefs.js` reaches only `Adw`, `Gio`,
`GLib`, `Gtk`, `Secret` and the providers' pure modules; `make imports` fails
on St, Clutter, Meta, Shell, Soup or a shell `resource:///` module reached
from it.

**Readable code: meets.** Plain ES modules, unminified. `make check` ends with
`./scripts/dev.sh size`: about 1800 lines of JavaScript, 6% comments, a `try`
only around file, network, keyring and JSON reads.

**Logging: failures only.** An install logs nothing on enable, disable or a
reading. `Log.debug` prints only under the `make link` development entry
point; `Log.warn` and `Log.error` are on failure paths (a response in an
unknown shape, a read that threw).

**`run_dispose()`, subprocesses, privileged processes, clipboard: none.**

**Other extensions: none touched.**

**Network: each provider's own server, with the user's own login.** For each
provider switched on whose CLI is on `PATH`, the login that CLI stored is read
(a file, or the system keyring for Antigravity) and sent to that provider's
endpoint, the request the CLI makes for its own usage command:
`api.anthropic.com`, `cloudcode-pa.googleapis.com`, `chatgpt.com`. Nothing
else is sent anywhere, no token is kept or logged, and no provider file is
written. The README's "Privacy and network" table and the description say so.

**Telemetry: none.**

**Schemas: meets.** `org.gnome.shell.extensions.ai-usage` at
`/org/gnome/shell/extensions/ai-usage/`, and a relocatable per-provider schema
under `/org/gnome/shell/extensions/ai-usage/providers/<id>/`, both in the one
XML file; `glib-compile-schemas --strict` passes.

**Licensing: GPL-2.0-or-later**, `LICENSE` in the zip. No code from other
extensions.

**Trademarks: names only.** No logo ships: the buttons use stock Adwaita
symbolic icons, with the extension's own gauge as the fallback. Claude,
Antigravity and Codex are named to say whose figures a button shows; the
README's "Credits and trademarks" says so and disclaims affiliation.

**Best practices.** No `try` around `destroy()`, `disconnect()` or
`GLib.Source.remove()`, no `_destroyed` flags; `St.Icon` in the shell and
`Gtk.Image` in the preferences, no emoji; no line over 200 characters;
`enable()` and `disable()` side by side; `extension.js` is 15 lines.

## Private API

None.

## Uploading

https://extensions.gnome.org/upload/, signed in as the extension's owner, with
the zip from the GitHub release. extensions.gnome.org assigns `version`; the
review can take days and its comments arrive on the extension's page.
