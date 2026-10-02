import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Http} from './http.js';
import {UsageIndicator} from './indicator.js';
import {allProviders} from './providers/registry.js';
import {applyOptions, displayOptions, providerSettings} from './settings.js';
import {ResetFormat, Status, formatReset} from './usage.js';
import * as Log from './log.js';

// limit key -> the resets_at (unix seconds) it was notified for. Module scope so
// that lock and unlock, which disable and enable, do not notify again.
const notified = new Map();

// A scheduled poll is skipped after this long without input.
const IDLE_SKIP_MS = 10 * 60 * 1000;

// Opening a pop-up re-reads only figures older than this (microseconds).
const FRESH_FOR_US = 60 * GLib.TIME_SPAN_SECOND;

// The global keys that only change how the figures are drawn.
const DISPLAY_KEYS = ['warn-percent', 'critical-percent', 'primary-limit', 'show-percent', 'reset-format', 'notify-percent'];

export class AiUsageApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();

        this._http = null;
        this._buttons = new Map();   // provider id -> {indicator}
        this._entries = [];     // {provider, settings} per live provider
        this._raw = [];         // what the providers returned, untouched

        this._showPercent = true;
        this._pick = reading => reading.worst;
        this._resetFormat = ResetFormat.AUTO;
        this._interface = null;
        this._interfaceId = 0;
        this._clock = '24h';

        this._timerId = 0;
        this._debounceId = 0;
        this._cancellable = null;
        this._monitors = [];
        this._settingsIds = [];
        this._providerSettingsById = new Map();
    }

    enable() {
        this._http = new Http(`gnome-shell-extension-ai-usage/${this._extension.metadata['version-name']}`);

        this._watchClock();
        this._readDisplay();

        this._buildEntries();
        this._watchSettings();

        this.refresh();
        this._schedule();
    }

    disable() {
        this._unschedule();
        this._cancelInFlight();

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        this._interface.disconnect(this._interfaceId);
        this._interfaceId = 0;
        this._interface = null;

        for (const {settings, handlerId} of this._providerSettingsById.values())
            settings.disconnect(handlerId);
        this._providerSettingsById.clear();
        this._entries = [];

        this._stopWatchingCredentials();
        if (this._debounceId)
            GLib.Source.remove(this._debounceId);
        this._debounceId = 0;

        for (const key of [...this._buttons.keys()])
            this._destroyButton(key);

        this._http.destroy();
        this._http = null;

        this._raw = [];
    }

    _readDisplay() {
        const s = this._settings;
        this._thresholds = {
            warn: s.get_int('warn-percent'),
            critical: s.get_int('critical-percent'),
        };
        this._notifyAt = s.get_int('notify-percent');

        const limitMode = s.get_string('primary-limit');
        this._showPercent = s.get_boolean('show-percent');
        this._pick = reading => pickLimit(reading, limitMode);
        this._resetFormat = s.get_string('reset-format');
        this._clock = this._interface.get_string('clock-format');
    }

    _buttonOptions() {
        return {showPercent: this._showPercent, pick: this._pick, resetFormat: this._resetFormat, clock: this._clock};
    }

    _displayChanged() {
        this._readDisplay();
        for (const {indicator} of this._buttons.values())
            indicator.configure(this._buttonOptions());
        this._redraw();
    }

    // A provider is live when it is switched on and its command-line tool is installed.
    _buildEntries() {
        this._entries = [];
        for (const provider of allProviders()) {
            const settings = this._providerSettings(provider.id);
            if (!settings.get_boolean('enabled'))
                continue;
            if (!provider.detect()) {
                Log.debug(`'${provider.cli}' is not installed; leaving ${provider.id} out.`);
                continue;
            }
            this._entries.push({provider, settings});
        }
        this._syncButtons();
        this._watchCredentials();
    }

    // Kept: a Gio.Settings that is collected stops emitting 'changed'.
    _providerSettings(id) {
        if (this._providerSettingsById.has(id))
            return this._providerSettingsById.get(id).settings;

        const settings = providerSettings(this._extension.dir, id);
        const handlerId = settings.connect('changed', (_s, key) => {
            if (key !== 'enabled') {
                this._redraw();
                return;
            }
            this._buildEntries();
            this.refresh();
        });
        this._providerSettingsById.set(id, {settings, handlerId});
        return settings;
    }

    _watchClock() {
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceId = this._interface.connect('changed::clock-format',
            () => this._displayChanged());
    }

    _watchSettings() {
        const on = (keys, handler) => {
            for (const key of keys)
                this._settingsIds.push(this._settings.connect(`changed::${key}`, handler));
        };
        on(['panel-box', 'panel-index'], () => this._placeButtons());
        on(['poll-seconds'], () => this._schedule());
        on(DISPLAY_KEYS, () => this._displayChanged());
    }

    _syncButtons() {
        const live = new Set(this._entries.map(e => e.provider.id));
        let changed = false;

        for (const id of [...this._buttons.keys()]) {
            if (!live.has(id)) {
                this._destroyButton(id);
                changed = true;
            }
        }

        for (const {provider} of this._entries) {
            if (this._buttons.has(provider.id))
                continue;
            this._buttons.set(provider.id, this._createButton(provider));
            changed = true;
        }

        if (changed) {
            this._placeButtons();
            Log.debug(`Top bar: ${this._buttons.size} button(s) — ${[...this._buttons.keys()].join(', ')}`);
        }
    }

    _createButton(provider) {
        const indicator = new UsageIndicator(this._iconFile(provider), provider.displayName);

        // Refresh reads every provider and leaves the pop-up open to watch the
        // figures change; the preferences close it.
        indicator.setActions([
            {label: 'Refresh now', icon: 'view-refresh-symbolic', action: () => this.refresh()},
            {label: 'Preferences', icon: 'go-next-symbolic', action: () => {
                indicator.menu.close(true);
                this._extension.openPreferences();
            }},
        ]);
        indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshIfStale();
        });

        indicator.configure(this._buttonOptions());
        indicator.setReading(null);
        return {indicator};
    }

    // Destroying the indicator releases its panel role, so a provider can be
    // switched off and on again without a restart.
    _destroyButton(id) {
        this._buttons.get(id).indicator.destroy();
        this._buttons.delete(id);
    }

    // A provider without an icon of its own gets the gauge.
    _iconFile(provider) {
        return this._extension.dir.get_child('icons').get_child(`${provider.icon ?? 'ai-usage-symbolic'}.svg`);
    }

    // addToStatusArea claims the role until the indicator is destroyed, so only
    // the first placement goes through it; a move reparents the container.
    _placeButtons() {
        const boxName = this._settings.get_string('panel-box');
        const index = this._settings.get_int('panel-index');
        const target = panelBox(boxName);

        let offset = 0;
        for (const {provider} of this._entries) {
            const button = this._buttons.get(provider.id);
            if (!button)
                continue;
            const container = button.indicator.container;
            const parent = container.get_parent();

            if (!parent) {
                Main.panel.addToStatusArea(`${this._extension.uuid}-${provider.id}`, button.indicator,
                    position(target, index, offset), boxName);
            } else {
                parent.remove_child(container);
                target.insert_child_at_index(container, position(target, index, offset));
            }
            offset++;
        }
    }

    // A read already out is cancelled, so the newest answer is the one shown.
    refresh() {
        this._cancelInFlight();
        if (!this._entries.length) {
            this._raw = [];
            this._redraw();
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._readAll(cancellable).catch(e => {
            if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            Log.error('Reading usage failed', e);
        }).finally(() => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        });
    }

    // Sweeping the pointer along open menus would otherwise start a read per button.
    _refreshIfStale() {
        const now = GLib.DateTime.new_now_utc();
        if (this._cancellable || this._raw.some(r => now.difference(r.at) < FRESH_FOR_US))
            return;
        this.refresh();
    }

    async _readAll(cancellable) {
        const readings = await Promise.all(this._entries.map(async ({provider}) => {
            const reading = await provider.read(this._http, cancellable);
            reading.cli = provider.cliName;
            return reading;
        }));

        if (cancellable.is_cancelled())
            return;

        this._raw = readings;
        this._redraw();
        // From the untouched readings: a hidden limit still notifies.
        this._maybeNotify();
    }

    // A provider that has not answered yet gets null ("Reading usage…").
    _redraw() {
        const byId = new Map(this._raw.map(reading => [reading.providerId, reading]));
        for (const {provider, settings} of this._entries) {
            const reading = byId.get(provider.id);
            this._buttons.get(provider.id).indicator.setReading(
                reading ? applyOptions(reading, displayOptions(settings), this._thresholds) : null);
        }
    }

    _cancelInFlight() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _schedule() {
        this._unschedule();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('poll-seconds'), () => {
            if (global.backend.get_core_idle_monitor().get_idletime() <= IDLE_SKIP_MS)
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

    // The tool rewriting its login means the figures moved, or an expired token is good again.
    _watchCredentials() {
        this._stopWatchingCredentials();
        for (const {provider} of this._entries) {
            const monitor = provider.credentialsFile().monitor_file(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', () => this._refreshSoon());
            this._monitors.push(monitor);
        }
    }

    _stopWatchingCredentials() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
    }

    // A credential write arrives as several events, and a read mid-write gets half a file.
    _refreshSoon() {
        if (this._debounceId)
            GLib.Source.remove(this._debounceId);
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._debounceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Once per limit per window, the window being its reset time.
    _maybeNotify() {
        if (!this._notifyAt)
            return;

        const now = GLib.DateTime.new_now_utc().to_unix();
        for (const [key, resetsAt] of notified) {
            if (resetsAt !== null && resetsAt < now)
                notified.delete(key);
        }

        for (const reading of this._raw) {
            if (reading.status !== Status.OK)
                continue;
            for (const limit of reading.limits) {
                const key = `${reading.providerId}:${limit.id}`;
                const window = limit.resetsAt?.to_unix() ?? null;

                if (limit.percent < this._notifyAt) {
                    notified.delete(key);
                    continue;
                }
                if (notified.has(key) && notified.get(key) === window)
                    continue;
                notified.set(key, window);

                const when = limit.resetsAt
                    ? ` ${formatReset(limit.resetsAt, {format: this._resetFormat, clock: this._clock})}.`
                    : '';
                Main.notify(`${reading.displayName} usage at ${Math.round(limit.percent)}%`,
                    `${limit.label}.${when}`);
            }
        }
    }
}

// A provider with no session or weekly limit falls back to its worst.
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

// -1 is last; any other index is clamped to what the box holds.
function position(target, index, offset) {
    if (index < 0)
        return -1;
    return Math.min(index + offset, target.get_n_children());
}

// Private: the only way to move an indicator that is already registered.
function panelBox(name) {
    return Main.panel[`_${name}Box`];
}
