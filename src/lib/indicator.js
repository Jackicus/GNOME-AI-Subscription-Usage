import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Severity, Status, formatBreakdown, formatPercent, formatReset} from './usage.js';

// Secondary text is dimmed with actor opacity, so it suits light and dark menus.
const DIM_OPACITY = 160;

const ICON_SIZE = 16;

// `.ai-usage-bar`'s height in the stylesheet: the narrowest fill that still
// looks like a bar with both ends rounded.
const BAR_HEIGHT = 4;

const SEVERITY_CLASS = {
    [Severity.NORMAL]: 'ai-usage-normal',
    [Severity.WARNING]: 'ai-usage-warning',
    [Severity.CRITICAL]: 'ai-usage-critical',
};

function explain(reading) {
    switch (reading.status) {
    case Status.SIGNED_OUT:
        return `Not signed in. Run ${reading.cli} and sign in there.`;
    case Status.EXPIRED:
        return `The stored login has expired. Run ${reading.cli} once and it will refresh itself.`;
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

// St has no percentage widths, so the fill is sized against the track's width.
// A box, not an St.Bin, which would centre the fill.
const UsageBar = GObject.registerClass(
class UsageBar extends St.BoxLayout {
    constructor(fraction, severity) {
        super({
            style_class: 'ai-usage-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._fraction = Math.max(0, Math.min(1, fraction));
        this._fill = new St.Widget({
            style_class: `ai-usage-bar-fill ${SEVERITY_CLASS[severity]}`,
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
        // Anything above 0% gets at least a dot, so 1% and 0% differ.
        const filled = Math.round(width * this._fraction);
        this._fill.set_width(this._fraction > 0 ? Math.max(BAR_HEIGHT, filled) : 0);
    }
});

export const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(iconFile, name) {
        super._init(0.5, `${name} usage`, false);

        this.add_style_class_name('ai-usage-panel-button');
        // menu.box is the actor that gets `.popup-menu-content`, so the width goes there.
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
        this._pick = null;      // (reading) => Limit
        this._resetFormat = null;
        this._clock = null;     // '12h' or '24h'

        this._name = name;
        this._actions = [];

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
    }

    // Stored, not drawn: the caller hands over a reading next.
    configure({showPercent, pick, resetFormat, clock}) {
        this._showPercent = showPercent;
        this._pick = pick;
        this._resetFormat = resetFormat;
        this._clock = clock;
    }

    // null until the provider has answered.
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
        if (!reading) {
            this._label.set_text('…');
            this._showFigure(true);
            this._setPanelSeverity(Severity.NORMAL);
            return;
        }

        const shown = reading.ok ? this._pick(reading) : null;
        // No figure: amber when the fix is the user's (signing in again).
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

    _showFigure(hasFigure) {
        this._label.visible = hasFigure && this._showPercent;
    }

    _setPanelSeverity(severity) {
        for (const cls of Object.values(SEVERITY_CLASS))
            this._box.remove_style_class_name(cls);
        this._box.add_style_class_name(SEVERITY_CLASS[severity]);
    }

    _renderMenu() {
        this._section.removeAll();

        // With nothing read yet the header still carries the actions.
        if (!this._reading) {
            this._section.addMenuItem(headerItem(this._name, null, this._actions));
            this._section.addMenuItem(captionItem('Reading usage…'));
        } else {
            this._addReading(this._reading);
        }
        this._padLastRow();
    }

    // St has no :last-child; the stylesheet pads the marked row.
    _padLastRow() {
        const rows = this._section.box.get_children();
        rows.at(-1).add_style_class_name('ai-usage-last');
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

        const breakdown = formatBreakdown(reading.breakdown);
        if (breakdown)
            this._section.addMenuItem(captionItem(breakdown));
    }

    // Drawn at the right of the header by the next setReading().
    setActions(items) {
        this._actions = items;
    }
});

// The shell's `icon-button flat`, as at the end of a Quick Settings slider row.
// Dimmed on the icon rather than the button, so the hover background stays full,
// and lit again on hover and focus, which the theme does not do for opacity.
function actionButton(label, iconName, action) {
    const icon = new St.Icon({icon_name: iconName, opacity: DIM_OPACITY});
    const button = new St.Button({
        style_class: 'icon-button flat',
        can_focus: true,
        accessible_name: label,
        y_align: Clutter.ActorAlign.CENTER,
        child: icon,
    });
    const light = () => {
        icon.opacity = button.hover || button.has_key_focus() ? 255 : DIM_OPACITY;
    };
    button.connect('notify::hover', light);
    button.connect('key-focus-in', light);
    button.connect('key-focus-out', light);
    button.connect('clicked', () => action());
    return button;
}

function inertItem(styleClass) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: styleClass,
    });
    return item;
}

// Name, plan dimmed beside it, the actions hard right. The plan (or, with no
// plan, the name) is the one expanding child, so the actions sit at the edge.
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

    const buttons = new St.BoxLayout({
        style_class: 'ai-usage-action-row',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });
    for (const {label, icon, action} of actions)
        buttons.add_child(actionButton(label, icon, action));
    row.add_child(buttons);

    item.add_child(row);
    return item;
}

// Name, dimmed reset, percentage, bar underneath, as Claude Code's /usage. The
// name is the one expanding column and the figure has a fixed-width cell, so
// the columns line up from row to row.
function limitItem(limit, resetFormat, clock) {
    const item = inertItem('ai-usage-limit');
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });

    const top = new St.BoxLayout({style_class: 'ai-usage-limit-row', x_expand: true});
    const name = new St.Label({
        text: limit.label,
        style_class: 'ai-usage-limit-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    // The name is what gets cut when the row is too narrow.
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

    // A box, not an St.Bin, so the figure ends where the bar does.
    const figure = new St.Label({
        text: formatPercent(limit.percent),
        style_class: `ai-usage-limit-figure ${SEVERITY_CLASS[limit.severity]}`,
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

// A limit row's top line with no figure and no bar, for a status with nothing
// to measure: an empty bar would claim a 0% the service never said.
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
