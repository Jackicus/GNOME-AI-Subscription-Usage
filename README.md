# AI Usage

A GNOME Shell extension that shows how much of your AI subscription you have
used, as a button in the top bar.

It lists the limits your provider actually enforces — the current session, the
week, and the week for each model — with a bar for each and the time it resets.
The button itself carries whichever figure is closest to running out, tinted
amber and then red as it climbs.

The figures come from your provider's own account, by the same request its
command-line tool makes for its own usage command, so what the top bar says and
what the terminal says are the same numbers.

## Signing in

You don't, here. **This extension never asks for a password and never signs you
in or out.** It reads the login that your provider's command-line tool has
already stored, which means:

* that tool has to be installed and already signed in;
* a provider whose tool isn't installed simply doesn't appear;
* if the stored login goes stale, the button says so and asks you to run the
  tool once — starting it refreshes the login by itself.

Keeping signing in where it already happens means there is one place to sign in,
one place to sign out, and no second copy of your credentials.

## Providers

| Provider | Needs | Status |
| --- | --- | --- |
| Claude | Claude Code (`claude`), signed in | Working, verified against a live account |
| Codex | the Codex CLI (`codex`), signed in with ChatGPT | Written, **never run against a live account** ([#8](https://github.com/Jackicus/GNOME-AI-Subscription-Usage/issues/8)) |

Each provider is switched on or off separately in the preferences, along with
what it shows — whether it may supply the figure on the button, whether its
per-model limits are listed, and so on. A provider is only offered the switches
it can actually honour.

More can be added; see `CLAUDE.md`.

## Installing

Not on extensions.gnome.org yet.

```sh
make install     # copy src/ into ~/.local/share/gnome-shell/extensions
```

A brand-new extension can't be enabled in a running Wayland session, so log out
and back in the first time, then:

```sh
gnome-extensions enable ai-usage@jackicus
```

## Checking what it sees

```sh
make providers
```

prints, for each provider, whether its command-line tool was found, whether a
login is stored, and the figures that come back — using the extension's own
code, so it is the quickest way to tell a data problem from a drawing problem.

```
Claude (claude)
  cli:      /usr/bin/claude
  plan:     Max 5x
  limits:
    Current session            [------------------------]   2%  resets in 3h 56m
    This week                  [#####-------------------]  20%  resets in 6 days
    This week · Fable          [#######-----------------]  29%  resets in 6 days, in force
  week went to: Claude Code 100%
```

## Development

`make help` lists everything. `make link` installs it as links into `src/` so
edits reload with `make reload` and no shell restart; `make pack` builds the zip
and refuses to ship a stray file.

`make check` is everything verifiable without a GNOME Shell: gjs.guide's ESLint
rules, plus `make parsers`, which runs each provider's parser over a saved
response and checks what comes out. For a provider whose command-line tool is
not installed on your machine, that is the only check there is.

## Licence

GPL-2.0-or-later.
