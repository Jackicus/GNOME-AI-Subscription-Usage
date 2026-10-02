import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Http} from './http.js';
import {UsageIndicator} from './indicator.js';
import {PROVIDERS} from './providers/registry.js';
import {applyOptions, providerSettings} from './settings.js';
import {Status, formatReset} from './usage.js';
import * as Log from './log.js';

// A scheduled poll is skipped after this long without input.
const IDLE_SKIP_MS = 10 * 60 * 1000;

// Opening a pop-up re-reads only figures older than this (microseconds).
const FRESH_FOR_US = 60 * GLib.TIME_SPAN_SECOND;

export class AiUsageApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();

        this._http = null;
        // provider id -> {provider, settings, handlerId, indicator, reading}, in registry order;
        // indicator is null while the provider is not live
        this._providers = new Map();
        this._notified = new Map();   // limit key -> the resets_at (unix seconds) it was notified for

        this._settingsId = 0;
        this._interface = null;
        this._interfaceId = 0;
        this._timerId = 0;
        this._debounceId = 0;
        this._cancellable = null;
        this._monitors = [];
    }

    enable() {
        this._http = new Http(`gnome-shell-extension-ai-usage/${this._extension.metadata['version-name']}`);

        for (const provider of PROVIDERS) {
            const settings = providerSettings(this._extension.dir, provider.id);
            const handlerId = settings.connect('changed', (_s, key) => {
                if (key !== 'enabled') {
                    this._redraw();
                    return;
                }
                this._syncButtons();
                this.refresh();
            });
            // A copy per enable, so whatever a provider caches goes with disable().
            this._providers.set(provider.id,
                {provider: Object.create(provider), settings, handlerId, indicator: null, reading: null});
        }

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'panel-box' || key === 'panel-index')
                this._placeButtons();
            else if (key === 'poll-seconds')
                this._schedule();
            else
                this._redraw();
        });
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceId = this._interface.connect('changed::clock-format', () => this._redraw());

        this._syncButtons();
        this.refresh();
        this._schedule();
    }

    disable() {
        this._unschedule();
        this._cancelInFlight();

        this._settings.disconnect(this._settingsId);
        this._interface.disconnect(this._interfaceId);
        this._interface = null;

        for (const {settings, handlerId, indicator} of this._providers.values()) {
            settings.disconnect(handlerId);
            indicator?.destroy();
        }
        this._providers.clear();

        this._stopWatchingCredentials();
        if (this._debounceId)
            GLib.Source.remove(this._debounceId);
        this._debounceId = 0;

        this._http.destroy();
        this._http = null;
    }

    _live() {
        return [...this._providers.values()].filter(entry => entry.indicator);
    }

    // A provider is live when it is switched on and its command-line tool is
    // installed.
    _syncButtons() {
        let changed = false;
        for (const entry of this._providers.values()) {
            const {provider, settings} = entry;
            let live = settings.get_boolean('enabled');
            if (live && !GLib.find_program_in_path(provider.cli)) {
                Log.debug(`'${provider.cli}' is not installed; leaving ${provider.id} out.`);
                live = false;
            }
            if (live === !!entry.indicator)
                continue;

            changed = true;
            if (live) {
                entry.indicator = this._createButton(provider);
            } else {
                entry.indicator.destroy();
                entry.indicator = null;
                entry.reading = null;
            }
        }

        if (changed) {
            this._placeButtons();
            Log.debug(`Top bar: ${this._live().length} button(s) — ${this._live().map(e => e.provider.id).join(', ')}`);
        }
        this._watchCredentials();
    }

    _createButton(provider) {
        const gauge = this._extension.dir.get_child('icons').get_child('ai-usage-symbolic.svg');
        // Refresh reads every provider and leaves the pop-up open to watch the
        // figures change; the preferences close it.
        const indicator = new UsageIndicator(provider.icon, gauge, provider.displayName, [
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
        return indicator;
    }

    // addToStatusArea claims the role until the indicator is destroyed, so a
    // button already placed is built afresh to be placed again. -1, or an
    // index past the end of the box, appends.
    _placeButtons() {
        const box = this._settings.get_string('panel-box');
        const index = this._settings.get_int('panel-index');

        let offset = 0;
        for (const entry of this._live()) {
            if (entry.indicator.container.get_parent()) {
                entry.indicator.destroy();
                entry.indicator = this._createButton(entry.provider);
            }
            Main.panel.addToStatusArea(`${this._extension.uuid}-${entry.provider.id}`, entry.indicator,
                index < 0 ? -1 : index + offset++, box);
        }
        this._redraw();
    }

    // A read already out is cancelled, so the newest answer is the one shown.
    refresh() {
        this._cancelInFlight();
        if (!this._live().length)
            return;

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._readAll(cancellable).catch(e => {
            if (!cancellable.is_cancelled())
                Log.error('Reading usage failed', e);
        }).finally(() => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        });
    }

    // Sweeping the pointer along open menus would otherwise start a read per button.
    _refreshIfStale() {
        const now = GLib.DateTime.new_now_utc();
        if (this._cancellable || this._live().some(e => e.reading && now.difference(e.reading.at) < FRESH_FOR_US))
            return;
        this.refresh();
    }

    async _readAll(cancellable) {
        const live = this._live();
        const readings = await Promise.all(live.map(({provider}) => provider.read(this._http, cancellable)));
        if (cancellable.is_cancelled())
            return;

        live.forEach((entry, i) => {
            entry.reading = readings[i];
            entry.reading.cli = entry.provider.cliName;
        });
        this._redraw();
        // From the untouched readings: a hidden limit still notifies.
        this._maybeNotify();
    }

    // A provider that has not answered yet gets null ("Reading usage…").
    _redraw() {
        const s = this._settings;
        const thresholds = {warn: s.get_int('warn-percent'), critical: s.get_int('critical-percent')};
        const options = {
            showPercent: s.get_boolean('show-percent'),
            limit: s.get_string('primary-limit'),
            resetFormat: s.get_string('reset-format'),
            clock: this._interface.get_string('clock-format'),
        };
        for (const {settings, indicator, reading} of this._live()) {
            const shown = reading && applyOptions(reading, {
                showPerModel: settings.get_boolean('show-per-model'),
                showBreakdown: settings.get_boolean('show-breakdown'),
                showCredits: settings.get_boolean('show-credits'),
            }, thresholds);
            indicator.setReading(shown, options);
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
        for (const {provider} of this._live()) {
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
        const notifyAt = this._settings.get_int('notify-percent');
        if (!notifyAt)
            return;

        const now = GLib.DateTime.new_now_utc().to_unix();
        for (const [key, resetsAt] of this._notified) {
            if (resetsAt !== null && resetsAt < now)
                this._notified.delete(key);
        }

        const wording = {format: this._settings.get_string('reset-format'), clock: this._interface.get_string('clock-format')};
        for (const {reading} of this._live()) {
            if (reading.status !== Status.OK)
                continue;
            for (const limit of reading.limits) {
                const key = `${reading.providerId}:${limit.id}`;
                const window = limit.resetsAt?.to_unix() ?? null;

                if (limit.percent < notifyAt) {
                    this._notified.delete(key);
                    continue;
                }
                if (this._notified.has(key) && this._notified.get(key) === window)
                    continue;
                this._notified.set(key, window);

                const when = limit.resetsAt ? ` ${formatReset(limit.resetsAt, wording)}.` : '';
                Main.notify(`${reading.displayName} usage at ${Math.round(limit.percent)}%`,
                    `${limit.label}.${when}`);
            }
        }
    }
}
