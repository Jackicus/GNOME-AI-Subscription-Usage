// What holds the extension together: when to read the providers, where the
// button sits, and what the settings mean.
//
// The reading side is deliberately lazy. Polling on a timer is the fallback,
// not the mechanism -- the two things that actually matter are opening the
// pop-up (you are looking at it now) and the stored login changing on disk
// (the tool just ran, so the figures moved). A five-minute timer between those
// is enough to keep the panel figure honest without asking the service for
// numbers nobody is reading.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Http} from './http.js';
import {UsageIndicator} from './indicator.js';
import {allProviders} from './providers/registry.js';
import {applyOptions, displayOptions, providerSettings} from './settings.js';
import {Status} from './usage.js';
import * as Log from './log.js';

const PANEL_BOXES = {left: 'left', center: 'center', right: 'right'};

// Past this much time with no input, a scheduled poll is skipped: nobody is
// looking at the top bar, and opening the pop-up reads afresh anyway.
const IDLE_SKIP_MS = 10 * 60 * 1000;

export class AiUsageApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();

        this._http = null;
        this._indicator = null;
        this._entries = [];     // {provider, settings, options} per live provider
        this._raw = [];         // what the providers returned, untouched
        this._readings = [];    // the above with the display switches applied

        this._timerId = 0;
        this._debounceId = 0;
        this._cancellable = null;
        this._monitors = [];
        this._settingsIds = [];
        this._providerSettingsById = new Map();
        this._notified = new Map();   // limit id -> the resets_at it was notified for
    }

    enable() {
        this._http = new Http(`gnome-shell-extension-ai-usage/${this._extension.metadata['version-name'] ?? 'dev'}`);

        this._indicator = new UsageIndicator(this._extension.dir.get_child('icons').get_child('ai-usage-symbolic.svg'));
        this._indicator.setFooter([
            {label: 'Refresh now', action: () => this.refresh()},
            {label: 'Preferences', action: () => this._extension.openPreferences()},
        ]);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.refresh();
        });

        this._applySettings();
        this._watchSettings();
        this._placeIndicator();

        this._indicator.setBusy();
        this.refresh();
        this._schedule();
    }

    disable() {
        this._unschedule();
        this._cancelInFlight();

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        // Disconnected by hand rather than left to garbage collection. The
        // shell disables at lock and enables again at unlock, so a handler
        // still attached to a surviving Gio.Settings would call into an app
        // that has already been taken down.
        for (const {settings, handlerId} of this._providerSettingsById.values()) {
            if (settings && handlerId)
                settings.disconnect(handlerId);
        }
        this._providerSettingsById.clear();
        this._entries = [];

        this._stopWatchingCredentials();

        this._indicator?.destroy();
        this._indicator = null;

        this._http?.destroy();
        this._http = null;

        this._raw = [];
        this._readings = [];
        this._notified.clear();
    }

    // ---- settings -----------------------------------------------------------

    _applySettings() {
        const s = this._settings;
        this._thresholds = {
            warn: s.get_int('warn-percent'),
            critical: s.get_int('critical-percent'),
        };
        this._notifyAt = s.get_int('notify-percent');
        this._pollSeconds = s.get_int('poll-seconds');
        this._pollWhenIdle = s.get_boolean('poll-when-idle');

        this._buildEntries();

        const mode = s.get_string('primary-limit');
        this._indicator?.configure({
            showPercent: s.get_boolean('show-percent'),
            pick: reading => pickLimit(reading, mode),
        });

        this._watchCredentials();
    }

    // A provider is live when it is switched on *and* its command-line tool is
    // installed. An absent tool leaves it out rather than showing it as an
    // error: it is not something the user asked for and failed to get.
    _buildEntries() {
        this._entries = [];
        for (const provider of allProviders()) {
            const settings = this._providerSettings(provider.id);
            if (!settings || !settings.get_boolean('enabled'))
                continue;
            if (!provider.detect()) {
                Log.debug(`'${provider.cli}' is not installed; leaving ${provider.id} out.`);
                continue;
            }
            this._entries.push({provider, settings, options: displayOptions(settings)});
        }
        this._watchCredentials();
    }

    // Built once per provider and kept: a Gio.Settings that goes out of scope
    // stops delivering its 'changed' signal.
    _providerSettings(id) {
        if (this._providerSettingsById.has(id))
            return this._providerSettingsById.get(id).settings;

        let settings = null;
        let handlerId = 0;
        try {
            settings = providerSettings(this._extension.dir, id);
            // Any of this provider's switches changing is a reason to rebuild
            // and redraw; only `enabled` needs the figures fetched again.
            handlerId = settings.connect('changed', (_s, key) => {
                this._buildEntries();
                if (key === 'enabled')
                    this.refresh();
                else
                    this._redraw();
            });
        } catch (e) {
            Log.error(`Could not open settings for provider '${id}'`, e);
        }
        this._providerSettingsById.set(id, {settings, handlerId});
        return settings;
    }

    _watchSettings() {
        const relayout = ['panel-box', 'panel-index'];
        const reread = ['warn-percent', 'critical-percent'];

        for (const key of [...relayout, ...reread, 'primary-limit', 'show-percent', 'poll-seconds', 'poll-when-idle', 'notify-percent']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._applySettings();
                if (relayout.includes(key))
                    this._placeIndicator();
                if (key === 'poll-seconds')
                    this._schedule();
                // A changed threshold changes the severity of figures already
                // on screen, so the numbers have to be run through again.
                if (reread.includes(key))
                    this.refresh();
                else
                    this._redraw();
            }));
        }
    }

    // The first placement registers the button with the panel; every later one
    // is a move. They cannot both go through addToStatusArea: it claims the
    // role for good -- the role is only released when the indicator is
    // destroyed -- so calling it twice throws an extension point conflict.
    // A move therefore reparents the container into the panel's box itself,
    // which is what every extension that offers a position setting does.
    _placeIndicator() {
        if (!this._indicator)
            return;
        const boxName = PANEL_BOXES[this._settings.get_string('panel-box')] ?? 'right';
        const index = this._settings.get_int('panel-index');
        const container = this._indicator.container;

        if (!container.get_parent()) {
            Main.panel.addToStatusArea(this._extension.uuid, this._indicator, index, boxName);
            return;
        }

        const target = panelBox(boxName);
        if (!target) {
            Log.warn(`The shell has no '${boxName}' panel box; leaving the button where it is.`);
            return;
        }

        container.get_parent().remove_child(container);
        // -1 means last, which insert_child_at_index already takes; any other
        // index is clamped, since what else is in the box is not ours to know.
        const count = target.get_n_children();
        target.insert_child_at_index(container, index < 0 ? -1 : Math.min(index, count));
    }

    // ---- reading ------------------------------------------------------------

    // Every path to fresh figures comes through here. A poll already out is
    // cancelled rather than raced, so the newest answer is always the one shown.
    refresh() {
        if (!this._http || !this._entries.length) {
            this._raw = [];
            this._readings = [];
            this._indicator?.setReadings([]);
            return;
        }

        this._cancelInFlight();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._readAll(cancellable).catch(e => {
            if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            Log.error('Reading usage failed', e);
        });
    }

    async _readAll(cancellable) {
        // Providers are independent, so they go out together; a slow one does
        // not hold up the rest.
        const readings = await Promise.all(this._entries.map(async ({provider}) => {
            try {
                const reading = await provider.read(this._http, cancellable, this._thresholds);
                reading.cli = provider.cliName ?? provider.cli;
                return reading;
            } catch (e) {
                if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                // A provider is not supposed to throw; if one does, that is a
                // bug in it, and the rest of the pop-up should still work.
                Log.error(`Provider '${provider.id}' threw`, e);
                return null;
            }
        }));

        if (cancellable.is_cancelled() || this._cancellable !== cancellable)
            return;

        this._raw = readings.filter(r => r);
        this._redraw();
        // Notifications go off the untouched readings: a limit you chose not to
        // list is still a limit you want to hear about before it stops you.
        this._maybeNotify();
    }

    // Re-applies the display switches to figures already in hand. Turning a row
    // off costs no request, and turning it back on restores it at once, because
    // the switches are applied to the untouched readings every time.
    _redraw() {
        const byId = new Map(this._entries.map(e => [e.provider.id, e.options]));
        this._readings = this._raw
            .filter(reading => byId.has(reading.providerId))
            .map(reading => applyOptions(reading, byId.get(reading.providerId)));
        this._indicator?.setReadings(this._readings);
    }

    _cancelInFlight() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    // ---- when to read -------------------------------------------------------

    _schedule() {
        this._unschedule();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._pollSeconds, () => {
            if (this._pollWhenIdle || !this._userIsIdle())
                this.refresh();
            else
                Log.debug('Skipping a poll: the session is idle.');
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unschedule() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    _userIsIdle() {
        try {
            return global.backend.get_core_idle_monitor().get_idletime() > IDLE_SKIP_MS;
        } catch (e) {
            // If the shell ever moves this, poll as though someone is watching
            // rather than going quiet for good.
            Log.debug(`Could not read the idle time, assuming active: ${e.message}`);
            return false;
        }
    }

    // The stored login being rewritten means the tool just ran, which is both
    // the moment the figures moved and the moment an expired token became good
    // again. Cheaper and far more timely than shortening the poll interval.
    _watchCredentials() {
        this._stopWatchingCredentials();
        for (const {provider} of this._entries) {
            const file = provider.credentialsFile?.();
            if (!file)
                continue;
            try {
                const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                // Writers rename over the file as often as they write in place,
                // so every event is treated the same: read again shortly.
                monitor.connect('changed', () => this._refreshSoon());
                this._monitors.push(monitor);
            } catch (e) {
                Log.debug(`Could not watch ${provider.id}'s credentials: ${e.message}`);
            }
        }
    }

    _stopWatchingCredentials() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        if (this._debounceId) {
            GLib.Source.remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    // A credential write arrives as several events in a row, and reading
    // mid-write gets half a file. Two seconds after the last one is both
    // settled and still immediate to a person.
    _refreshSoon() {
        if (this._debounceId)
            GLib.Source.remove(this._debounceId);
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._debounceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- notifications ------------------------------------------------------

    // Once per limit per window. The window is identified by its reset time, so
    // the same limit notifies again after it resets and climbs again, but not
    // twice on the way up.
    _maybeNotify() {
        if (!this._notifyAt)
            return;

        for (const reading of this._raw) {
            if (reading.status !== Status.OK)
                continue;
            for (const limit of reading.limits) {
                const key = `${reading.providerId}:${limit.id}`;
                const window = limit.resetsAt?.format_iso8601() ?? '';

                if (limit.percent < this._notifyAt) {
                    // Below the line again -- usually a reset -- so let it speak
                    // next time it climbs.
                    this._notified.delete(key);
                    continue;
                }
                if (this._notified.get(key) === window)
                    continue;
                this._notified.set(key, window);

                const when = limit.resetsAt ? `, ${formatResetPlain(limit.resetsAt)}` : '';
                Main.notify(`${reading.displayName} usage at ${Math.round(limit.percent)}%`,
                    `${limit.label}${when}.`);
            }
        }
    }
}

// The button shows one figure; this is which. "highest" is the default because
// it is the limit that will stop you first, whichever window it belongs to.
function pickLimit(reading, mode) {
    switch (mode) {
    case 'session':
        return reading.find(l => l.id === 'session') ?? reading.worst;
    case 'weekly':
        return reading.find(l => l.id === 'weekly_all') ?? reading.worst;
    default:
        return reading.worst;
    }
}

// The panel's boxes are private, but reparenting into them is the only way to
// move an indicator that is already registered, and it is long-standing
// practice among extensions that offer a position setting.
function panelBox(name) {
    switch (name) {
    case 'left':
        return Main.panel._leftBox;
    case 'center':
        return Main.panel._centerBox;
    default:
        return Main.panel._rightBox;
    }
}

function formatResetPlain(resetsAt) {
    const local = resetsAt.to_local();
    return `resets ${local.format('%H:%M on %A')}`;
}
