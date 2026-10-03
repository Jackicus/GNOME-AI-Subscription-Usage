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
* The bars are the shell's `BarLevel`, drawn from `-barlevel-*` properties on
  `.ai-usage-bar` and its severity class. It reads `-barlevel-overdrive-color`
  too, so that is set though never drawn. A row whose `percent` is null (credits
  switched off, a balance) has no figure and no bar.
* The percentage cell is an `St.BoxLayout`, not an `St.Bin`, for the kit's
  `St.Bin` reason: the figure floated mid-cell.
* The last pop-up row is marked `ai-usage-last` by `_renderMenu()`, for want of
  `:last-child`.
* Dimming is actor opacity (`DIM_OPACITY`). `min-width` does exist.
* **Its exception to the kit's colour rule**: the bar track's mid grey and
  GNOME's own warning/critical palette (Yellow 5 `#e5a50a`, Red 4 `#e01b24`) are
  the only flat colours, since St names no warning colour. A normal bar is
  `-st-accent-color`. No foreground colour is hardcoded.
* Paddings are px measured from the shell's own theme (`.popup-menu-item`,
  `.quick-settings`), each with its reason beside it.
