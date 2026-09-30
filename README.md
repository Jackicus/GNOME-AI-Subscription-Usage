# AI Usage

A GNOME Shell extension that shows how much of your AI subscription you have
used, as a button in the top bar.

![The pop-up for Claude on a Max (20x) plan: the 5-hour limit at 0%, the week
across all models at 24%, and the week for the model in force at 30%, each with
the time it resets, above "Refresh now" and
"Preferences".](docs/screenshots/pop-up.png)

It lists the limits your provider actually enforces — the current session, the
week, and the week for each model — with the percentage used, a bar, and the
time it resets. The figures come from your provider's own account, by the same
request its command-line tool makes for its own usage command, so what the top
bar says and what the terminal says are the same numbers.

There is a button per subscription, carrying whichever of that subscription's
figures is closest to running out, tinted amber and then red as it climbs.

![Two buttons at the right of the top bar: the Claude mark reading 30%, and the
Antigravity mark in amber.](docs/screenshots/top-bar-cropped.png)

Claude at 30%, and beside it Antigravity in amber — which is not a reading. That
is the warning tint: these were photographed in a throwaway session with no
keyring, so Antigravity's stored login could not be read, and the button says so
rather than showing a number.

The pictures on this page are of GNOME Shell 50 in the dark theme, taken in the
throwaway session `./scripts/dev.sh shots` drives. That is as far as the drawing
has been checked: it has not been through a light theme, a narrow menu, or a
second machine.

## You never sign in here

This extension never asks for a password and never signs you in or out. It reads
the login that your provider's command-line tool has already stored, so that
tool has to be installed and already signed in, and a provider whose tool isn't
installed simply doesn't appear. If the stored login goes stale the button says
so and asks you to run the tool once — starting it refreshes the login by
itself.

## Providers

| Provider | Needs | Status |
| --- | --- | --- |
| Claude | Claude Code (`claude`), signed in | Working, verified against a live account |
| Antigravity | the Antigravity CLI (`agy`), signed in | Working, verified against a live account |
| Codex | the Codex CLI (`codex`), signed in with ChatGPT | Written, **never run against a live account** ([#8](https://github.com/Jackicus/GNOME-AI-Subscription-Usage/issues/8)) |

Where a tool keeps its login in the system keyring rather than a file — as the
Antigravity CLI does — the extension reads it from there.

## Installing

Not on extensions.gnome.org yet.

```sh
git clone https://github.com/Jackicus/GNOME-AI-Subscription-Usage
cd GNOME-AI-Subscription-Usage
make install     # copy src/ into ~/.local/share/gnome-shell/extensions
```

A brand-new extension cannot be enabled in a running Wayland session, so the
first time you have to **log out and back in**, then:

```sh
gnome-extensions enable ai-usage@jackicus
```

## The preferences

Each provider is switched on or off separately, along with what it shows — and a
provider is only offered the switches it can actually honour.

![The Providers page of the preferences, listing Claude found at
/usr/bin/claude, Codex with "the Codex CLI is not installed — this provider is
left out", and Antigravity found at
/home/hp/.local/bin/agy.](docs/screenshots/preferences-providers.png)

<details>
<summary>The other two pages</summary>

![The Buttons page: one button per provider or a single shared one, which figure
each button carries, whether the percentage is shown beside the icon, and the
start of the pop-up section, which is where reset times are
worded.](docs/screenshots/preferences-buttons.png)

![The Readings page: seconds between readings, whether to keep reading while
idle, and the figure at which a limit notifies
you.](docs/screenshots/preferences-readings.png)

</details>

## If nothing appears

Take these in order — each rules out one layer:

```sh
make status      # is it installed, and does the running shell know about it?
make providers   # can it read the figures at all, outside the shell?
make logs        # what the shell says about it
```

`make providers` is the useful one: if it prints your figures then the data side
is fine and the problem is the button, and if it does not then the button was
never going to show anything.

<details>
<summary>What <code>make providers</code> looks like</summary>

```
Claude (claude)
  cli:      /usr/bin/claude
  plan:     Max (20x)
  limits:
    5-hour limit               [------------------------]   0%  Resets in 4 hr 52 min
    Weekly · all models        [######------------------]  24%  Resets Tue 15:00
    Weekly · Fable             [#######-----------------]  30%  Resets Tue 15:00, in force
  week went to: Claude Code 100%

Codex (codex)
  'codex' is not on PATH -- the extension leaves this provider out.

Antigravity (antigravity)
  cli:      /home/hp/.local/bin/agy
  plan:     (unknown)
  status:   expired -- the stored login was rejected -- run its command-line tool once to refresh it
```

It runs the extension's own provider modules outside the shell, so it is reading
the same code the button does.

</details>

A provider missing from the pop-up means its command-line tool is not on `PATH`
— that is deliberate, not a failure. A button that says the login has expired
means run that tool once, and the button will catch up within a few seconds.

## Development

`make help` lists every target. `make check` is everything verifiable without a
GNOME Shell, and `CLAUDE.md` is the design: where the figures come from, what
each file is for, and how to add a provider.

## Licence

GPL-2.0-or-later.
