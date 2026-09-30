// The button in the top bar and the pop-up under it.
//
// It renders Readings and nothing else: no polling, no provider knowledge, no
// settings reads. Whatever put it on screen hands it a set of Readings with
// setReadings(), and it draws them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Severity, Status, formatPercent, formatReset} from './usage.js';

// Secondary text is dimmed with actor opacity rather than a colour, so it
// stays legible whether the menu is light or dark.
const DIM_OPACITY = 160;

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
    case Status.UNAVAILABLE:
        return reading.message
            ? `Usage could not be read: ${reading.message}`
            : 'Usage could not be read just now.';
    default:
        return 'Usage could not be read.';
    }
}

// A track with a fill across part of it. St has no percentage widths, so the
// fill is sized against the track's allocation each time that changes -- which
// also covers the pop-up being opened at a different width.
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
    _init(iconFile) {
        super._init(0.5, 'AI Usage', false);

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
        this._showPercent = true;
        this._pick = null;      // (reading) => Limit, set by whoever drives us

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this._footer = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._footer);
    }

    // `pick` chooses the limit the button itself shows, so the setting that
    // decides that lives with the settings and not in here.
    configure({showPercent, pick}) {
        this._showPercent = showPercent;
        this._pick = pick;
        this._render();
    }

    setReadings(readings) {
        this._readings = readings;
        this._render();
    }

    // Shown while the first poll is still out, so the button is never blank.
    setBusy() {
        if (!this._readings.length)
            this._label.set_text('…');
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
            this._label.visible = false;
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
            this._label.visible = false;
            return;
        }

        this._label.visible = this._showPercent;
        this._label.set_text(formatPercent(shown.percent));
        this._setPanelSeverity(shown.severity);
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
            this._section.addMenuItem(limitItem(limit));

        if (reading.credits)
            this._section.addMenuItem(limitItem({
                label: reading.credits.label,
                percent: reading.credits.percent,
                severity: reading.credits.severity ?? Severity.NORMAL,
                resetsAt: null,
                active: false,
            }));

        if (reading.breakdown.length) {
            const parts = reading.breakdown.map(row => `${row.label} ${formatPercent(row.percent)}`);
            this._section.addMenuItem(captionItem(`This week: ${parts.join(' · ')}`));
        }
    }

    // The items below the providers -- a refresh and the preferences -- are set
    // by the caller, which owns both actions.
    setFooter(items) {
        this._footer.removeAll();
        if (!items.length)
            return;
        this._footer.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const {label, action} of items) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => action());
            this._footer.addMenuItem(item);
        }
    }
});

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

// Label and percentage on one line, the bar under it, when it resets under that.
function limitItem(limit) {
    const item = inertItem('ai-usage-limit');
    const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });

    const top = new St.BoxLayout({x_expand: true});
    const label = new St.Label({
        text: limit.label,
        style_class: limit.active ? 'ai-usage-limit-label ai-usage-active' : 'ai-usage-limit-label',
    });
    top.add_child(label);
    top.add_child(new St.Label({
        text: formatPercent(limit.percent),
        style_class: `ai-usage-limit-percent ${SEVERITY_CLASS[limit.severity] ?? SEVERITY_CLASS[Severity.NORMAL]}`,
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
    }));
    column.add_child(top);
    column.add_child(new UsageBar(limit.percent / 100, limit.severity));

    const reset = formatReset(limit.resetsAt);
    if (reset) {
        const caption = new St.Label({text: reset, style_class: 'ai-usage-caption'});
        caption.opacity = DIM_OPACITY;
        column.add_child(caption);
    }

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
