// A button in the top bar and the pop-up under it.
//
// It renders Readings and nothing else: no polling, no provider knowledge, no
// settings reads. Whatever put it on screen hands it a set of Readings with
// setReadings(), and it draws them.
//
// How many of these there are, and which readings each one gets, is app.js's
// business: one per provider carrying that provider's own reading and icon, or
// a single one carrying them all. Nothing in here knows which arrangement it
// is in -- a button given one reading and a button given four draw the same
// way.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ResetFormat, Severity, Status, formatBreakdown, formatPercent, formatReset} from './usage.js';

// Secondary text is dimmed with actor opacity rather than a colour, so it
// stays legible whether the menu is light or dark.
const DIM_OPACITY = 160;

// What the shell's own panel icons are, and so what the icon is drawn at until
// something says otherwise.
const DEFAULT_ICON_SIZE = 16;

const SEVERITY_CLASS = {
    [Severity.NORMAL]: 'ai-usage-normal',
    [Severity.WARNING]: 'ai-usage-warning',
    [Severity.CRITICAL]: 'ai-usage-critical',
};

// What a user can do about each way of having no figures. The wording matters
// more than it looks: these are the only words shown when the button is useless,
// so each one names the fix.
function explain(reading) {
    switch (reading.status) {
    case Status.SIGNED_OUT:
        return `Not signed in. Run ${reading.cli ?? 'its command-line tool'} and sign in there.`;
    case Status.EXPIRED:
        return `The stored login has expired. Run ${reading.cli ?? 'its command-line tool'} once and it will refresh itself.`;
    case Status.UNSUPPORTED:
        return reading.message ?? 'This login has no subscription limits to show.';
    case Status.UNAVAILABLE:
        return reading.message
            ? `Usage could not be read: ${reading.message}`
            : 'Usage could not be read just now.';
    default:
        return 'Usage could not be read.';
    }
}

// A rule with a fill across part of it -- a few pixels tall, square, the
// unfilled part barely there. St has no percentage widths, so the fill is sized
// against the track's allocation each time that changes, which also covers the
// pop-up being opened at a different width.
const UsageBar = GObject.registerClass(
class UsageBar extends St.Bin {
    // St.Bin adds no _init of its own, so this takes the modern constructor
    // form. UsageIndicator below cannot: PanelMenu.Button defines _init, and
    // going through a constructor would skip it.
    constructor(fraction, severity) {
        super({
            style_class: 'ai-usage-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._fraction = Math.max(0, Math.min(1, fraction));
        this._fill = new St.Widget({
            style_class: `ai-usage-bar-fill ${SEVERITY_CLASS[severity] ?? SEVERITY_CLASS[Severity.NORMAL]}`,
            x_align: Clutter.ActorAlign.START,
        });
        this.set_child(this._fill);

        this.connect('notify::width', () => this._resize());
    }

    _resize() {
        const width = this.get_width();
        if (width <= 0)
            return;
        // A limit with anything at all in it gets at least a sliver, so that
        // "1%" and "0%" do not look identical.
        const filled = Math.round(width * this._fraction);
        this._fill.set_width(this._fraction > 0 ? Math.max(2, filled) : 0);
    }
});

export const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    // The icon and the name are the caller's: with a button per provider they
    // are that provider's, and they are what tells two percentages in the top
    // bar apart.
    _init(iconFile, name) {
        super._init(0.5, name ? `${name} usage` : 'AI Usage', false);

        this._box = new St.BoxLayout({style_class: 'ai-usage-panel-box'});
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            style_class: 'ai-usage-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._readings = [];
        this._showIcon = true;
        this._showPercent = true;
        this._pick = null;      // (reading) => Limit, set by whoever drives us
        this._resetFormat = ResetFormat.AUTO;

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this._footer = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._footer);
    }

    // `pick` chooses the limit the button itself shows, and `resetFormat` how
    // a reset time is worded, so the settings that decide both live with the
    // settings and not in here. `showIcon`, `showPercent` and `iconSize` are
    // what the button is made of; the rule that stops the last of them being
    // turned off is applied before they get here, in settings.js.
    configure({showIcon = true, showPercent, iconSize, pick, resetFormat}) {
        this._showIcon = showIcon;
        this._showPercent = showPercent;
        this._icon.icon_size = iconSize > 0 ? iconSize : DEFAULT_ICON_SIZE;
        this._pick = pick;
        this._resetFormat = resetFormat ?? ResetFormat.AUTO;
        this._render();
    }

    setReadings(readings) {
        this._readings = readings;
        this._render();
    }

    // Shown while the first poll is still out, so the button is never blank.
    // The visibility has to be set too: the first render happens before any
    // reading exists and hides the label, so setting only the text showed
    // nothing at all.
    setBusy() {
        if (this._readings.length)
            return;
        this._label.set_text('…');
        this._showFigure(true);
    }

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        // A provider can be listed in the pop-up yet barred from the button,
        // which is how one subscription becomes the one you actually watch.
        const usable = this._readings.filter(r => r.ok && r.limits.length && r.panelEligible);
        // With nothing readable the button keeps its icon but drops the figure,
        // and turns the colour of the worst thing wrong.
        if (!usable.length) {
            this._label.set_text('');
            this._showFigure(false);
            const broken = this._readings.some(r => r.status === Status.EXPIRED || r.status === Status.SIGNED_OUT);
            this._setPanelSeverity(broken ? Severity.WARNING : Severity.NORMAL);
            return;
        }

        // Across providers, the one closest to its limit is the one to show:
        // that is the number that decides whether you can keep working.
        let shown = null;
        for (const reading of usable) {
            const limit = this._pick?.(reading) ?? reading.worst;
            if (limit && (!shown || limit.percent > shown.percent))
                shown = limit;
        }
        if (!shown) {
            this._showFigure(false);
            return;
        }

        this._label.set_text(formatPercent(shown.percent));
        this._showFigure(true);
        this._setPanelSeverity(shown.severity);
    }

    // The one arrangement a button must never end up in is empty: an actor with
    // no icon and no figure is zero width, still there and still clickable in
    // principle, and completely invisible -- which reads as the extension being
    // broken rather than as anything anyone asked for. settings.js refuses that
    // pair of switches; this is the same rule where the drawing happens, which
    // is the only place that also knows the other way to have no figure -- that
    // none has arrived yet, or that nothing readable came back at all. So the
    // icon comes back whenever the figure is absent, whatever its switch says.
    _showFigure(hasFigure) {
        this._label.visible = hasFigure && this._showPercent;
        this._icon.visible = this._showIcon || !this._label.visible;
    }

    _setPanelSeverity(severity) {
        for (const cls of Object.values(SEVERITY_CLASS))
            this._box.remove_style_class_name(cls);
        this._box.add_style_class_name(SEVERITY_CLASS[severity] ?? SEVERITY_CLASS[Severity.NORMAL]);
    }

    _renderMenu() {
        this._section.removeAll();

        if (!this._readings.length) {
            this._section.addMenuItem(captionItem('Reading usage…'));
            return;
        }

        let first = true;
        for (const reading of this._readings) {
            if (!first)
                this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            first = false;
            this._addReading(reading);
        }
    }

    _addReading(reading) {
        this._section.addMenuItem(headerItem(reading.displayName, reading.plan));

        if (!reading.ok) {
            this._section.addMenuItem(captionItem(explain(reading)));
            return;
        }

        for (const limit of reading.limits)
            this._section.addMenuItem(limitItem(limit, this._resetFormat));

        if (reading.credits)
            this._section.addMenuItem(limitItem({
                label: reading.credits.label,
                percent: reading.credits.percent,
                severity: reading.credits.severity ?? Severity.NORMAL,
                resetsAt: null,
                active: false,
            }, this._resetFormat));

        // Silent unless it has something to report: one surviving row is 100%
        // by definition, and under a row that is a limit it would read as one.
        const breakdown = formatBreakdown(reading.breakdown);
        if (breakdown)
            this._section.addMenuItem(captionItem(breakdown));
    }

    // The actions below the providers -- a refresh and the preferences -- are
    // set by the caller, which owns both. They are drawn the way Quick Settings
    // draws its own: a right-aligned row of circular icon buttons, which is the
    // shape a GNOME menu's actions have, rather than two more full-width rows
    // that would read as more limits.
    setFooter(items) {
        this._footer.removeAll();
        if (!items.length)
            return;
        this._footer.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const row = inertItem('ai-usage-actions');
        const buttons = new St.BoxLayout({
            style_class: 'ai-usage-action-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        for (const {label, icon, action} of items)
            buttons.add_child(actionButton(label, icon, action));
        row.add_child(buttons);
        this._footer.addMenuItem(row);
    }
});

// An action as Quick Settings draws one. `icon-button` is the shell's own
// class, not an imitation of it: taking it means the hover, focus, :insensitive
// and :checked states, and how all four behave on a light menu and a dark one,
// come from the theme and keep coming from it when the theme changes. Only what
// `.quick-settings` adds to that class has to be said again here, since this
// menu is not inside one -- see the stylesheet.
//
// The label becomes the accessible name, because an icon on its own says
// nothing at all to a screen reader.
//
// Whether an action closes the pop-up is the action's own business and stays
// with the caller: a refresh leaves it open, because its whole point is the
// figures you are looking at changing in front of you, and the preferences
// close it, because a window is about to open over it.
function actionButton(label, iconName, action) {
    const button = new St.Button({
        style_class: 'icon-button',
        can_focus: true,
        accessible_name: label,
        child: new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}),
    });
    button.connect('clicked', () => action());
    return button;
}

// ---- the rows ---------------------------------------------------------------

function inertItem(styleClass) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: styleClass,
    });
    // PopupBaseMenuItem is itself a horizontal St.BoxLayout, so a single
    // child laid out as a column is all these rows need. Its constructor puts
    // an ornament icon in as well; that is left alone -- it is already hidden
    // (Ornament.HIDDEN), a hidden actor takes no space, and clearing the
    // children would orphan the icon the item still holds a reference to.
    return item;
}

function headerItem(name, plan) {
    const item = inertItem('ai-usage-header');
    const row = new St.BoxLayout({x_expand: true});
    row.add_child(new St.Label({text: name, style_class: 'ai-usage-provider'}));
    if (plan) {
        const planLabel = new St.Label({
            text: plan,
            style_class: 'ai-usage-plan',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        planLabel.opacity = DIM_OPACITY;
        row.add_child(planLabel);
    }
    item.add_child(row);
    return item;
}

// One row per limit, laid out the way Claude Code's own /usage panel lays it
// out: the name hard left, the reset dimmed and right-aligned beside it, the
// percentage hard right, and the rule under all three.
//
// Three columns where the middle one changes width will not line up between
// rows on their own, and the percentages lining up is the whole point of the
// right-hand column. So exactly one column expands -- the name -- and it
// absorbs every bit of slack in the row. That alone fixes the right edge of the
// percentage column, but not its left edge, which would still slide about with
// "9%" against "100%"; so the figure sits in a cell of its own with a width
// from the stylesheet, and is aligned to the end of it. With that cell a fixed
// size, the reset column's right edge is fixed too, and all three line up down
// the pop-up.
function limitItem(limit, resetFormat) {
    const item = inertItem('ai-usage-limit');
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });

    const top = new St.BoxLayout({style_class: 'ai-usage-limit-row', x_expand: true});
    const name = new St.Label({
        text: limit.label,
        style_class: limit.active ? 'ai-usage-limit-label ai-usage-active' : 'ai-usage-limit-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    // The name is the one column that may be cut: at a width that will not hold
    // all three, a shortened label still says which limit this is, while a
    // shortened figure or reset time would be wrong rather than brief.
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    top.add_child(name);

    const reset = formatReset(limit.resetsAt, {format: resetFormat});
    if (reset) {
        const label = new St.Label({
            text: reset,
            style_class: 'ai-usage-limit-reset',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.opacity = DIM_OPACITY;
        top.add_child(label);
    }

    // The cell takes the width; the label inside it takes the colour, so the
    // severity paints the figure and not an empty box around it.
    const figure = new St.Label({
        text: formatPercent(limit.percent),
        style_class: `ai-usage-limit-figure ${SEVERITY_CLASS[limit.severity] ?? SEVERITY_CLASS[Severity.NORMAL]}`,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });
    top.add_child(new St.Bin({style_class: 'ai-usage-limit-percent', child: figure}));

    column.add_child(top);
    column.add_child(new UsageBar(limit.percent / 100, limit.severity));

    item.add_child(column);
    return item;
}

function captionItem(text) {
    const item = inertItem('ai-usage-caption-row');
    const label = new St.Label({text, style_class: 'ai-usage-caption', x_expand: true});
    label.opacity = DIM_OPACITY;
    label.clutter_text.line_wrap = true;
    item.add_child(label);
    return item;
}
