// Preferences. Everything here binds straight to a GSettings key, so there is
// no state of its own to keep in step.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {allProviders} from './lib/providers/registry.js';
import {keyAppliesTo, keysFor, providerSettings} from './lib/settings.js';

// prefs.js runs in its own process, without the shell's imports, so it can only
// load modules that stay clear of St and of the shell's resource:// paths. The
// provider registry does -- deliberately -- so the list of providers here is
// the real one rather than a copy kept in step by hand.

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buttonPage(settings));
        window.add(this._readingPage(settings));
        // The provider rows need the global settings too: one of their
        // switches only means something in one of the panel modes.
        window.add(this._providersPage(settings));
    }

    _buttonPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Buttons',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const arrangement = new Adw.PreferencesGroup({
            title: 'How many',
            description: 'A button per provider keeps every percentage beside the icon of the subscription it '
                + 'belongs to. A single button spends one slot in the top bar instead, carrying whichever provider '
                + 'is closest to its limit and listing them all in the one pop-up.',
        });
        arrangement.add(comboRow(settings, 'panel-mode', 'Buttons in the top bar', [
            ['per-provider', 'One button per provider'],
            ['combined', 'A single button for all of them'],
        ]));
        page.add(arrangement);

        const shown = new Adw.PreferencesGroup({
            title: 'What they show',
            description: 'A pop-up always lists every limit. This is the single figure on the button itself.',
        });
        shown.add(comboRow(settings, 'primary-limit', 'Figure on each button', [
            ['highest', 'Whichever is highest'],
            ['session', 'Current session'],
            ['weekly', 'This week'],
        ]));
        const icon = switchRow(settings, 'show-icon', 'Show the icon',
            "The provider's own icon, which is what says whose percentage this is.");
        const percent = switchRow(settings, 'show-percent', 'Show the percentage',
            'With this off a button is its icon alone, tinted by how much has been used.');
        shown.add(icon);
        shown.add(percent);
        shown.add(spinRow(settings, 'icon-size', 'Icon size',
            "In pixels. The shell's own panel icons are 16.", 12, 24));
        keepOneOf(settings, 'show-icon', 'show-percent', icon);
        page.add(shown);

        const popup = new Adw.PreferencesGroup({
            title: 'The pop-up',
            description: 'Every limit carries the time it resets. This is how that time is worded, in the pop-ups '
                + 'and in the notifications alike. An exact time is in your own timezone, on the clock your desktop '
                + 'is set to.',
        });
        popup.add(comboRow(settings, 'reset-format', 'Reset times', [
            ['auto', 'Automatic — a countdown when it is close, a time when it is not'],
            ['relative', 'How long until it resets'],
            ['absolute', 'The time it resets'],
            ['both', 'Both'],
        ]));
        page.add(popup);

        const place = new Adw.PreferencesGroup({
            title: 'Where they sit',
            description: 'The buttons go side by side in the chosen end of the top bar. Which neighbours they land '
                + 'between also depends on what other extensions have put there.',
        });
        place.add(comboRow(settings, 'panel-box', 'Part of the top bar', [
            ['left', 'Left, by Activities'],
            ['center', 'Centre, by the clock'],
            ['right', 'Right, among the status icons'],
        ]));
        place.add(spinRow(settings, 'panel-index', 'Position', 'Where the first button goes, counting from the middle of the bar; -1 puts them last.', -1, 20));
        page.add(place);

        const colour = new Adw.PreferencesGroup({
            title: 'Colour',
            description: 'A limit past the first figure turns amber, past the second red.',
        });
        colour.add(spinRow(settings, 'warn-percent', 'Nearly used up', null, 1, 100));
        colour.add(spinRow(settings, 'critical-percent', 'Almost gone', null, 1, 100));
        page.add(colour);

        return page;
    }

    _readingPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Readings',
            icon_name: 'preferences-system-time-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'How often',
            description: 'Opening the pop-up always reads the figures again, and so does signing in or refreshing your login, '
                + 'so a long interval here still gives you fresh numbers whenever you look.',
        });
        group.add(spinRow(settings, 'poll-seconds', 'Seconds between readings', null, 60, 3600, 30));
        group.add(switchRow(settings, 'poll-when-idle', 'Keep reading while idle',
            'Off by default: with nobody at the machine the readings are skipped until you come back.'));
        page.add(group);

        const notify = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Crossing the figure notifies you once for that limit, and not again until it resets.',
        });
        notify.add(spinRow(settings, 'notify-percent', 'Notify at', 'Zero turns notifications off.', 0, 100));
        page.add(notify);

        return page;
    }

    _providersPage(shared) {
        const page = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'system-users-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'This extension never signs you in and never stores a password. It reads the login that each '
                + "provider's own command-line tool has already saved, so signing in and out stays in one place. "
                + 'A provider needs that tool installed and already signed in; one whose tool is missing gets no '
                + 'button whatever its switch says.',
        });

        for (const provider of allProviders())
            group.add(this._providerRow(provider, shared));

        page.add(group);
        return page;
    }

    _providerRow(provider, shared) {
        const path = GLib.find_program_in_path(provider.cli);
        const tool = provider.cliName ?? provider.cli;

        const row = new Adw.ExpanderRow({
            title: provider.displayName,
            subtitle: path
                ? `${tool} found at ${path}`
                : `${tool} is not installed — this provider is left out`,
        });

        // The header switch is `enabled`; the rows inside are what to show.
        let settings = null;
        try {
            settings = providerSettings(this.dir, provider.id);
        } catch (e) {
            row.subtitle = `Settings unavailable: ${e.message}`;
            return row;
        }

        const toggle = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            // A provider whose tool is missing cannot be read whatever the
            // switch says, so the switch does not pretend otherwise.
            sensitive: path !== null,
        });
        settings.bind('enabled', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(toggle);

        // Only the switches this provider can actually honour: its capabilities
        // decide, so a provider with no per-model limits is never offered one.
        for (const key of keysFor(provider)) {
            const child = new Adw.SwitchRow({title: key.title, subtitle: key.subtitle ?? ''});
            settings.bind(key.key, child, 'active', Gio.SettingsBindFlags.DEFAULT);
            // Two things decide whether a row can be touched: the provider
            // being switched on, and -- for a key that only means something in
            // one panel mode -- the top bar being in that mode. A GSettings
            // bind carries one source, so this is kept in step by hand. Left
            // visible rather than hidden, so the window does not jump when the
            // mode changes; insensitive says plainly that it does nothing.
            const sync = () => {
                child.sensitive = settings.get_boolean('enabled')
                    && keyAppliesTo(key, shared.get_string('panel-mode'));
            };
            sync();
            const watched = [
                [settings, settings.connect('changed::enabled', sync)],
                [shared, shared.connect('changed::panel-mode', sync)],
            ];
            child.connect('destroy', () => watched.forEach(([s, id]) => s.disconnect(id)));
            row.add_row(child);
        }

        return row;
    }
}

// A button with neither its icon nor its percentage is zero pixels wide: still
// there, still clickable in principle, and completely invisible, which reads as
// the extension being broken. The shell refuses the pair outright -- see
// buttonOptions() -- and this is that same rule made visible: turning the second
// switch off turns the *other* one back on, in front of the user, so the switch
// they just touched stays where they put it and the preferences never quietly
// disagree with it.
//
// The handlers outlive neither the window nor each other: both are dropped when
// the row they were added beside goes.
function keepOneOf(settings, a, b, row) {
    const rescue = (touched, other) => () => {
        if (!settings.get_boolean(touched) && !settings.get_boolean(other))
            settings.set_boolean(other, true);
    };
    const ids = [
        settings.connect(`changed::${a}`, rescue(a, b)),
        settings.connect(`changed::${b}`, rescue(b, a)),
    ];
    row.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
}

// ---- rows -------------------------------------------------------------------

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({
        title,
        subtitle: subtitle ?? '',
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Adw.ComboRow works on a position, while the setting is a nickname, so the two
// are mapped across rather than bound.
function comboRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });

    const nicks = choices.map(([nick]) => nick);
    const sync = () => {
        const index = nicks.indexOf(settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    sync();

    row.connect('notify::selected', () => {
        const nick = nicks[row.selected];
        if (nick && nick !== settings.get_string(key))
            settings.set_string(key, nick);
    });
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changedId));

    return row;
}
