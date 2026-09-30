// Preferences. Everything here binds straight to a GSettings key, so there is
// no state of its own to keep in step.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {allProviders} from './lib/providers/registry.js';
import {keysFor, providerSettings} from './lib/settings.js';

// prefs.js runs in its own process, without the shell's imports, so it can only
// load modules that stay clear of St and of the shell's resource:// paths. The
// provider registry does -- deliberately -- so the list of providers here is
// the real one rather than a copy kept in step by hand.

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buttonPage(settings));
        window.add(this._readingPage(settings));
        window.add(this._providersPage());
    }

    _buttonPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Button',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const shown = new Adw.PreferencesGroup({
            title: 'What it shows',
            description: 'The pop-up always lists every limit. This is the single figure on the button itself.',
        });
        shown.add(comboRow(settings, 'primary-limit', 'Figure on the button', [
            ['highest', 'Whichever is highest'],
            ['session', 'Current session'],
            ['weekly', 'This week'],
        ]));
        shown.add(switchRow(settings, 'show-percent', 'Show the percentage',
            'With this off the button is the icon alone, tinted by how much has been used.'));
        page.add(shown);

        const place = new Adw.PreferencesGroup({
            title: 'Where it sits',
            description: 'Which neighbours it lands between also depends on what other extensions have put in the top bar.',
        });
        place.add(comboRow(settings, 'panel-box', 'Part of the top bar', [
            ['left', 'Left, by Activities'],
            ['center', 'Centre, by the clock'],
            ['right', 'Right, among the status icons'],
        ]));
        place.add(spinRow(settings, 'panel-index', 'Position', 'Counting from the middle of the bar; -1 puts it last.', -1, 20));
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

    _providersPage() {
        const page = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'system-users-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'This extension never signs you in and never stores a password. It reads the login that each '
                + "provider's own command-line tool has already saved, so signing in and out stays in one place. "
                + 'A provider needs that tool installed and already signed in; one whose tool is missing is left out '
                + 'of the pop-up whatever its switch says.',
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
        for (const {key, title, subtitle} of keysFor(provider)) {
            const child = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
            settings.bind(key, child, 'active', Gio.SettingsBindFlags.DEFAULT);
            settings.bind('enabled', child, 'sensitive', Gio.SettingsBindFlags.GET);
            row.add_row(child);
        }

        return row;
    }
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
