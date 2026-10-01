// A button in the top bar and the pop-up under it.
//
// It renders a Reading and nothing else: no polling, no provider knowledge, no
// settings reads. Whatever put it on screen hands it its provider's Reading
// with setReading(), and it draws it.

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

// What the shell's own panel icons are, and so what the icon is drawn at.
const ICON_SIZE = 16;

// `.ai-usage-bar`'s height in the stylesheet, where it is the shell's own
// `-barlevel-height`. Repeated here because _resize() has to know it: with both
// ends fully rounded, it is also the narrowest a fill can be drawn and still
// look like a bar.
const BAR_HEIGHT = 4;

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

// A track with a fill across part of it, shaped like the shell's own sliders:
// four pixels tall, both ends fully rounded, the unfilled part barely there. St
// has no percentage widths, so the fill is sized against the track's allocation
// each time that changes, which also covers the pop-up being opened at a
// different width.
const UsageBar = GObject.registerClass(
class UsageBar extends St.BoxLayout {
    // A box rather than an St.Bin, and that is the whole point of it: a bin
    // centres its single child, and setting `x_align: START` on the child does
    // not change that -- which is why every bar in this pop-up drew its fill
    // as a segment floating in the middle of the track. A horizontal box packs
    // from the start edge, so the fill begins at the left because that is
    // where a box puts the first child, not because it was asked to.
    //
    // St.BoxLayout adds no _init of its own, so this takes the modern
    // constructor form. UsageIndicator below cannot: PanelMenu.Button defines
    // _init, and going through a constructor would skip it.
    constructor(fraction, severity) {
        super({
            style_class: 'ai-usage-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._fraction = Math.max(0, Math.min(1, fraction));
        this._fill = new St.Widget({
            style_class: `ai-usage-bar-fill ${SEVERITY_CLASS[severity] ?? SEVERITY_CLASS[Severity.NORMAL]}`,
            // Never expanded: the width is set outright in _resize(), and an
            // expanding child would be stretched to the whole track.
            x_expand: false,
            y_expand: true,
        });
        this.add_child(this._fill);

        this.connect('notify::width', () => this._resize());
    }

    _resize() {
        const width = this.get_width();
        if (width <= 0)
            return;
        // A limit with anything at all in it gets at least a sliver, so that
        // "1%" and "0%" do not look identical. The floor is the bar's own
        // height, and that is not a coincidence: both ends are fully rounded,
        // so a fill narrower than its height is a circle with its sides cut
        // off -- it stops looking like the start of a bar and starts looking
        // like a rendering fault. At exactly the height it is a full dot.
        const filled = Math.round(width * this._fraction);
        this._fill.set_width(this._fraction > 0 ? Math.max(BAR_HEIGHT, filled) : 0);
    }
});

export const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    // The icon and the name are the provider's, and they are what tells two
    // percentages in the top bar apart.
    _init(iconFile, name) {
        super._init(0.5, `${name} usage`, false);

        // Two style classes of this extension's own, and neither is decoration:
        // the button's one condenses the shell's 12px of panel padding, which
        // around an icon and a short figure leaves the button's edge a long way
        // from what it is showing; the menu's one is where the pop-up's width
        // is set, and it goes on `menu.box` because that is the actor the shell
        // gives `.popup-menu-content` to and so the one every row is laid out
        // against.
        this.add_style_class_name('ai-usage-panel-button');
        this.menu.box.add_style_class_name('ai-usage-menu');

        this._box = new St.BoxLayout({style_class: 'ai-usage-panel-box'});
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: ICON_SIZE,
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            style_class: 'ai-usage-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._reading = null;
        this._showPercent = true;
        this._pick = null;      // (reading) => Limit, set by whoever drives us
        this._resetFormat = ResetFormat.AUTO;
        this._clock = null;     // '12h' or '24h', the desktop's; null reads as 24h

        // The pop-up's own title when there is no reading to head it -- see
        // _renderMenu(), where the actions still have to be reachable.
        this._name = name;
        this._actions = [];

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
    }

    // `pick` chooses the limit the button itself shows, `resetFormat` how a
    // reset time is worded and `clock` the 12/24-hour clock it is worded on, so
    // the settings that decide all three live with the settings and not in here.
    //
    // Stored, not drawn: the caller always hands over a reading next, and that
    // is the one render, however many settings changed.
    configure({showPercent, pick, resetFormat, clock}) {
        this._showPercent = showPercent;
        this._pick = pick;
        this._resetFormat = resetFormat ?? ResetFormat.AUTO;
        this._clock = clock ?? null;
    }

    // null until the provider has answered. This is the only thing that draws.
    setReading(reading) {
        this._reading = reading;
        this._render();
    }

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        const reading = this._reading;
        // Nothing answered yet: an ellipsis, so the button is never blank
        // while the first read is out.
        if (!reading) {
            this._label.set_text('…');
            this._showFigure(true);
            this._setPanelSeverity(Severity.NORMAL);
            return;
        }

        const shown = reading.ok ? this._pick?.(reading) ?? reading.worst : null;
        // With nothing readable the button keeps its icon but drops the figure,
        // and turns amber when the fix is the user's: signing in again.
        if (!shown) {
            this._label.set_text('');
            this._showFigure(false);
            const broken = reading.status === Status.EXPIRED || reading.status === Status.SIGNED_OUT;
            this._setPanelSeverity(broken ? Severity.WARNING : Severity.NORMAL);
            return;
        }

        this._label.set_text(formatPercent(shown.percent));
        this._showFigure(true);
        this._setPanelSeverity(shown.severity);
    }

    // The icon is always there, so the button is never empty; only the figure
    // comes and goes.
    _showFigure(hasFigure) {
        this._label.visible = hasFigure && this._showPercent;
    }

    _setPanelSeverity(severity) {
        for (const cls of Object.values(SEVERITY_CLASS))
            this._box.remove_style_class_name(cls);
        this._box.add_style_class_name(SEVERITY_CLASS[severity] ?? SEVERITY_CLASS[Severity.NORMAL]);
    }

    _renderMenu() {
        this._section.removeAll();

        // Nothing read yet: the pop-up still needs its refresh and its way to
        // the preferences. So the empty state gets a header of its own to
        // carry the actions -- the name this button was built with, since
        // there is no reading to take one from.
        if (!this._reading) {
            this._section.addMenuItem(headerItem(this._name, null, this._actions));
            this._section.addMenuItem(captionItem('Reading usage…'));
        } else {
            this._addReading(this._reading);
        }
        this._padLastRow();
    }

    // The bottom of the pop-up is the bottom of whatever row happened to come
    // last, and those rows do not carry the same padding -- a limit's is 9px, a
    // caption's 6px -- so the space under the last one drifted away from the
    // space over the first. St has no `:last-child`, so the last row is marked
    // here instead and the stylesheet gives that one row the padding that
    // squares the margin off.
    _padLastRow() {
        const rows = this._section.box.get_children();
        rows[rows.length - 1]?.add_style_class_name('ai-usage-last');
    }

    _addReading(reading) {
        this._section.addMenuItem(headerItem(reading.displayName, reading.plan, this._actions));

        if (!reading.ok) {
            this._section.addMenuItem(captionItem(explain(reading)));
            return;
        }

        for (const limit of reading.limits)
            this._section.addMenuItem(limitItem(limit, this._resetFormat, this._clock));

        if (reading.credits?.percent === null)
            this._section.addMenuItem(statusItem(reading.credits.label, reading.credits.detail));
        else if (reading.credits)
            this._section.addMenuItem(limitItem({
                label: reading.credits.label,
                percent: reading.credits.percent,
                severity: reading.credits.severity,
                resetsAt: null,
                active: false,
            }, this._resetFormat, this._clock));

        // Silent unless it has something to report: one surviving row is 100%
        // by definition, and under a row that is a limit it would read as one.
        const breakdown = formatBreakdown(reading.breakdown);
        if (breakdown)
            this._section.addMenuItem(captionItem(breakdown));
    }

    // The actions -- a refresh and the preferences -- are set by the caller,
    // which owns both. They are drawn at the right-hand end of the header, the
    // way Claude Code's own usage panel puts an arrow level with its title and
    // Quick Settings puts one at the end of a slider row: no row of their own,
    // and so no height of their own. Stored, like configure(): the next
    // setReading() draws them.
    setActions(items) {
        this._actions = items ?? [];
    }
});

// An action as the shell draws one, copied from the arrow at the end of a
// Quick Settings slider row -- `St.Button`, `icon-button flat`, an `St.Icon`
// with no class of its own. Both classes are the shell's own, not an imitation
// of them: `icon-button` brings the hover, focus, :insensitive and :checked
// states and the icon's size, `flat` makes the resting background the menu's
// own so that nothing is drawn round the glyph until it is pointed at, and all
// of it goes on coming from the theme when the theme changes.
//
// The label becomes the accessible name, because an icon on its own says
// nothing at all to a screen reader -- and there is now not even a filled
// shape to find.
//
// Whether an action closes the pop-up is the action's own business and stays
// with the caller: a refresh leaves it open, because its whole point is the
// figures you are looking at changing in front of you, and the preferences
// close it, because a window is about to open over it.
//
// Drawn at full strength these two were the brightest thing in the pop-up --
// brighter than the figures, which are what it is for. So they are dimmed the
// way every other piece of secondary furniture here is: actor opacity, since
// St has no CSS opacity.
//
// The opacity goes on the icon and not on the button, and the difference
// matters: opacity multiplies down the tree, so dimming the button would take
// the theme's own hover background down with the glyph. And the theme does not
// bring the glyph back by itself -- `.icon-button.flat:hover` sets only
// `background-color`, the colour stays `#ffffff` either way, and a CSS colour
// cannot undo an actor's opacity in any case. So the hover is wired here.
function actionButton(label, iconName, action) {
    const icon = new St.Icon({icon_name: iconName, opacity: DIM_OPACITY});
    const button = new St.Button({
        style_class: 'icon-button flat',
        can_focus: true,
        accessible_name: label,
        y_align: Clutter.ActorAlign.CENTER,
        child: icon,
    });
    // Pointed at or tabbed to, it is the thing being used: full strength.
    const light = () => {
        icon.opacity = button.hover || button.has_key_focus() ? 255 : DIM_OPACITY;
    };
    button.connect('notify::hover', light);
    button.connect('key-focus-in', light);
    button.connect('key-focus-out', light);
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

// The provider's name, the plan dimmed beside it, and the pop-up's actions hard
// right. That is the shape Claude Code's own usage panel has, and it is what
// lets the actions cost no height: the row was already here.
//
// Exactly one thing in the row expands, and it is the plan, so all the slack
// lands between the plan and the buttons and the buttons sit against the right
// edge. With no plan the name takes that job instead.
function headerItem(name, plan, actions) {
    const item = inertItem('ai-usage-header');
    const row = new St.BoxLayout({style_class: 'ai-usage-header-row', x_expand: true});

    const nameLabel = new St.Label({
        text: name,
        style_class: 'ai-usage-provider',
        y_align: Clutter.ActorAlign.CENTER,
    });
    row.add_child(nameLabel);

    if (plan) {
        const planLabel = new St.Label({
            text: plan,
            style_class: 'ai-usage-plan',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        planLabel.opacity = DIM_OPACITY;
        row.add_child(planLabel);
    } else {
        nameLabel.x_expand = true;
        nameLabel.x_align = Clutter.ActorAlign.START;
    }

    if (actions?.length) {
        const buttons = new St.BoxLayout({
            style_class: 'ai-usage-action-row',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const {label, icon, action} of actions)
            buttons.add_child(actionButton(label, icon, action));
        row.add_child(buttons);
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
function limitItem(limit, resetFormat, clock) {
    const item = inertItem('ai-usage-limit');
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });

    const top = new St.BoxLayout({style_class: 'ai-usage-limit-row', x_expand: true});
    // Every limit's name is drawn the same way. Weight used to mean "the one
    // in force", which Claude Code's own panel does not distinguish either --
    // `limit.active` is still in the model (the dev scripts print it), it just
    // no longer changes how a row looks.
    const name = new St.Label({
        text: limit.label,
        style_class: 'ai-usage-limit-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    // The name is the one column that may be cut: at a width that will not hold
    // all three, a shortened label still says which limit this is, while a
    // shortened figure or reset time would be wrong rather than brief.
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    top.add_child(name);

    const reset = formatReset(limit.resetsAt, {format: resetFormat, clock});
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
    //
    // A box and not an St.Bin, for the reason UsageBar is a box: a bin centres
    // its single child and ignores the child's x_align, so the figure sat in
    // the middle of this 3.5em cell -- 12px short of where the bar below it
    // ends -- however firmly it was told to align to the end. In a box the
    // expanding child is handed the slack and then aligned inside it, so END
    // means the end.
    const figure = new St.Label({
        text: formatPercent(limit.percent),
        style_class: `ai-usage-limit-figure ${SEVERITY_CLASS[limit.severity] ?? SEVERITY_CLASS[Severity.NORMAL]}`,
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const percent = new St.BoxLayout({style_class: 'ai-usage-limit-percent'});
    percent.add_child(figure);
    top.add_child(percent);

    column.add_child(top);
    column.add_child(new UsageBar(limit.percent / 100, limit.severity));

    item.add_child(column);
    return item;
}

// A row with a name and nothing to measure -- extra usage that is switched
// off. Laid out as a limit row's top line, so the name lines up with the names
// above it and the detail sits where a reset time would, but with no figure
// and no bar: an empty bar would claim a 0% that the service never said.
function statusItem(text, detail) {
    const item = inertItem('ai-usage-limit');
    const top = new St.BoxLayout({style_class: 'ai-usage-limit-row', x_expand: true});
    const name = new St.Label({
        text,
        style_class: 'ai-usage-limit-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    top.add_child(name);

    if (detail) {
        const label = new St.Label({
            text: detail,
            style_class: 'ai-usage-limit-reset',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.opacity = DIM_OPACITY;
        top.add_child(label);
    }

    item.add_child(top);
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
