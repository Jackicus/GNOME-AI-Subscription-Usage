---
paths:
  - "src/lib/indicator.js"
  - "src/stylesheet.css"
---

# The button and its pop-up

* The pop-up copies Claude Code's `/usage`: name (the one expanding column),
  dimmed reset, percentage in a fixed `min-width` cell, bar underneath. Refresh
  and preferences are the shell's `icon-button flat` at the header's right end,
  dimmed on the icon (not the button, or the hover background dims too) and lit
  on hover/focus by `actionButton()`. The empty state still gets a header.
* `UsageBar` and the percentage cell are `St.BoxLayout`s, not `St.Bin`s, for the
  kit's `St.Bin` reason: the fill and the figures both floated mid-cell.
* The last pop-up row is marked `ai-usage-last` by `_padLastRow()`, for want of
  `:last-child`.
* Dimming is actor opacity (`DIM_OPACITY`); the bar fill is sized against its
  track on `notify::width`, for want of percentage widths. `min-width` does exist.
* **Its exception to the kit's colour rule**: the bar track's mid grey and
  GNOME's own warning/critical palette (Yellow 5 `#e5a50a`, Red 4 `#e01b24`) are
  the only flat colours, since St names no warning colour. The fill's
  `-st-accent-color` follows a plain-blue fallback declaration, which an older
  shell keeps. No foreground colour is hardcoded.
* Paddings are px measured from the shell's own theme (`.popup-menu-item`,
  `.quick-settings`, `#panel .panel-button`), each with its reason beside it.
* `PanelMenu.Button` defines `_init`, so `UsageIndicator` uses `_init`.
  `UsageBar` extends `St.BoxLayout`, which does not, so it uses
  `constructor`/`super`.
