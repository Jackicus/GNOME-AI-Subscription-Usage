import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {allProviders} from './lib/providers/registry.js';
import {keysFor, providerSettings} from './lib/settings.js';

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buttonPage(settings));
        window.add(this._readingPage(settings));
        window.add(this._providersPage());
    }

    _buttonPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Buttons',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const shown = new Adw.PreferencesGroup({
            title: 'What they show',
            description: 'A pop-up always lists every limit. This is the single figure on the button itself.',
        });
        shown.add(comboRow(settings, 'primary-limit', 'Figure on each button', [
            ['highest', 'Whichever is highest'],
            ['session', 'Current session'],
            ['weekly', 'This week'],
        ]));
        shown.add(switchRow(settings, 'show-percent', 'Show the percentage',
            'With this off a button is its icon alone, tinted by how much has been used.'));
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
            description: 'Opening the pop-up reads the figures again once they are a minute old, and so does signing in or refreshing your login, '
                + 'so a long interval here still gives you fresh numbers whenever you look.',
        });
        group.add(spinRow(settings, 'poll-seconds', 'Seconds between readings', null, 60, 3600, 30));
        page.add(group);

        const notify = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Crossing the figure notifies you once for that limit, and not again until it resets.',
        });
        notify.add(spinRow(settings, 'notify-percent', 'Notify at', 'Zero turns notifications off.', 0, 100));
        page.add(notify);

        return page;
    }

    _providersPage() {
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
            group.add(this._providerRow(provider));

        page.add(group);
        return page;
    }

    _providerRow(provider) {
        const path = GLib.find_program_in_path(provider.cli);
        const tool = provider.cliName ?? provider.cli;

        const row = new Adw.ExpanderRow({
            title: provider.displayName,
            subtitle: path
                ? `${tool} found at ${path}`
                : `${tool} is not installed — this provider is left out`,
        });

        let settings = null;
        try {
            settings = providerSettings(this.dir, provider.id);
        } catch (e) {
            row.subtitle = `Settings unavailable: ${e.message}`;
            return row;
        }

        const toggle = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            sensitive: path !== null,
        });
        settings.bind('enabled', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(toggle);

        for (const key of keysFor(provider)) {
            const child = switchRow(settings, key.key, key.title);
            settings.bind('enabled', child, 'sensitive', Gio.SettingsBindFlags.GET);
            row.add_row(child);
        }

        return row;
    }
}

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

// Adw.ComboRow selects by position and the key holds a nick, so they are mapped by hand.
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
