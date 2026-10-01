// What holds the extension together: when to read the providers, where the
// buttons sit, and what the settings mean.
//
// There is a button per live provider: a percentage belongs to a subscription,
// so it sits beside an icon that names the subscription. A single shared
// button could not do that -- an unlabelled figure would switch from one
// subscription to another the moment the second overtook the first.
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
import {applyOptions, buttonOptions, displayOptions, providerSettings} from './settings.js';
import {ResetFormat, Status, formatReset} from './usage.js';
import * as Log from './log.js';

const PANEL_BOXES = {left: 'left', center: 'center', right: 'right'};

// The gauge in icons/: the fallback for a provider that has been given no icon
// of its own, or whose file is missing.
const FALLBACK_ICON = 'ai-usage-symbolic.svg';

// Past this much time with no input, a scheduled poll is skipped: nobody is
// looking at the top bar, and opening the pop-up reads afresh anyway.
const IDLE_SKIP_MS = 10 * 60 * 1000;

export class AiUsageApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();

        this._http = null;
        this._buttons = new Map();   // provider id -> {indicator, menuId}
        this._entries = [];     // {provider, settings, options} per live provider
        this._raw = [];         // what the providers returned, untouched

        // How every button draws its figure. Held here rather than read at the
        // point of use, so that a button built later -- a provider switched on
        // mid-session -- starts out configured like the rest.
        //
        // What each button is made of -- the icon, the figure, the icon's size
        // -- with the rule that stops both of the first two being off already
        // applied to it.
        this._button = {showIcon: true, showPercent: true, iconSize: 16};
        this._pick = reading => reading.worst;
        // How a reset time is worded, in the pop-ups and in the notifications
        // alike -- they are the same sentence, so they go through the same
        // function and answer to the same setting.
        this._resetFormat = ResetFormat.AUTO;

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

        // _applySettings() builds the live provider list, and with it the
        // buttons, so there is none to place here.
        this._applySettings();
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

        // Every button goes, and the handler on each one's menu with it, for
        // the same reason: enable() builds the whole arrangement again.
        for (const key of [...this._buttons.keys()])
            this._destroyButton(key);

        this._http?.destroy();
        this._http = null;

        this._raw = [];
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

        const limitMode = s.get_string('primary-limit');
        this._button = buttonOptions(s);
        this._pick = reading => pickLimit(reading, limitMode);
        this._resetFormat = s.get_string('reset-format');

        this._buildEntries();
        for (const {indicator} of this._buttons.values()) {
            indicator.configure({...this._button, pick: this._pick, resetFormat: this._resetFormat});
            // configure() redraws, which blanks the label of a button that has
            // nothing to draw yet. setBusy() puts the ellipsis back, and does
            // nothing at all once figures have arrived.
            indicator.setBusy();
        }

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
            this._entries.push({
                provider,
                settings,
                options: displayOptions(settings),
            });
        }
        this._syncButtons();
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

        for (const key of [...relayout, ...reread, 'primary-limit', 'show-icon', 'show-percent', 'icon-size', 'reset-format', 'poll-seconds', 'poll-when-idle', 'notify-percent']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._applySettings();
                if (relayout.includes(key))
                    this._placeButtons();
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

    // ---- the buttons --------------------------------------------------------

    // Brings the buttons on screen into line with the live provider list.
    // Switching a provider off destroys its button and leaves the others
    // alone; switching it back on builds what is missing -- no shell restart
    // in either case.
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
            const built = this._createButton(provider);
            if (built) {
                this._buttons.set(provider.id, built);
                changed = true;
            }
        }

        // Only a button appearing or going moves anything. The display
        // switches change what a pop-up lists, not where the buttons sit.
        if (changed) {
            this._placeButtons();
            // What is actually in the top bar, which is the first thing worth
            // knowing when someone says nothing appeared.
            Log.debug(`Top bar: ${this._buttons.size} button(s) — ${[...this._buttons.keys()].join(', ')}`);
        }
    }

    _createButton(provider) {
        let indicator;
        try {
            indicator = new UsageIndicator(this._iconFile(provider), provider.displayName);
        } catch (e) {
            Log.error(`Could not build the '${provider.id}' button`, e);
            return null;
        }

        // Every pop-up carries the same two actions, at the right-hand end of
        // its header. Refresh reads every live provider, not just this
        // button's: a person asking for a refresh means all of it.
        //
        // The pop-up stays open for a refresh, so that the figures can be
        // watched changing; the preferences close it, since a window is about
        // to open where it is.
        indicator.setActions([
            {label: 'Refresh now', icon: 'view-refresh-symbolic', action: () => this.refresh()},
            {label: 'Preferences', icon: 'go-next-symbolic', action: () => {
                indicator.menu.close(true);
                this._extension.openPreferences();
            }},
        ]);
        const menuId = indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.refresh();
        });

        indicator.configure({...this._button, pick: this._pick, resetFormat: this._resetFormat});
        // Figures for a button built mid-session are a poll away, and a blank
        // button in the meantime looks broken.
        indicator.setBusy();
        return {indicator, menuId};
    }

    // Destroying the indicator is what releases its panel role: the shell drops
    // it from Main.panel.statusArea on the indicator's own 'destroy'. That is
    // why a provider can be switched off and on again without a restart.
    _destroyButton(id) {
        const button = this._buttons.get(id);
        this._buttons.delete(id);
        if (!button)
            return;
        if (button.menuId)
            button.indicator.menu.disconnect(button.menuId);
        button.indicator.destroy();
    }

    // A provider's own icon is what names the subscription a percentage belongs
    // to, so it matters more here than it looks. `provider.icon` names a file
    // in the extension's icons/; a provider that has none, or whose file is
    // missing, falls back to the gauge rather than losing its button.
    _iconFile(provider) {
        const icons = this._extension.dir.get_child('icons');
        const name = typeof provider.icon === 'string' ? provider.icon.replace(/\.svg$/, '') : '';
        if (name) {
            const file = icons.get_child(`${name}.svg`);
            if (file.query_exists(null))
                return file;
            Log.debug(`No icon '${name}.svg' for ${provider.id}; using the generic one.`);
        }
        return icons.get_child(FALLBACK_ICON);
    }

    // The first placement of a button registers it with the panel; every later
    // one is a move. They cannot both go through addToStatusArea: it claims the
    // role for good -- the role is only released when the indicator is
    // destroyed -- so calling it twice throws an extension point conflict.
    // A move therefore reparents the container into the panel's box itself,
    // which is what every extension that offers a position setting does.
    //
    // Placed in registry order, from `panel-index`, so that which button is
    // where does not depend on who answered first.
    _placeButtons() {
        const boxName = PANEL_BOXES[this._settings.get_string('panel-box')] ?? 'right';
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
                // The role is claimed for the life of the indicator, so it has
                // to be distinct per button or the second addToStatusArea throws.
                Main.panel.addToStatusArea(`${this._extension.uuid}-${provider.id}`, button.indicator,
                    position(target, index, offset), boxName);
            } else if (target) {
                parent.remove_child(container);
                target.insert_child_at_index(container, position(target, index, offset));
            } else {
                Log.warn(`The shell has no '${boxName}' panel box; leaving the buttons where they are.`);
                return;
            }
            offset++;
        }
    }

    // ---- reading ------------------------------------------------------------

    // Every path to fresh figures comes through here. A poll already out is
    // cancelled rather than raced, so the newest answer is always the one shown.
    refresh() {
        if (!this._http || !this._entries.length) {
            this._raw = [];
            this._redraw();
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
    //
    // A provider that has not answered yet is handed null, which is what puts
    // "Reading usage…" in its pop-up.
    _redraw() {
        const byId = new Map(this._raw.map(reading => [reading.providerId, reading]));
        for (const {provider, options} of this._entries) {
            const reading = byId.get(provider.id);
            this._buttons.get(provider.id)?.indicator.setReading(
                reading ? applyOptions(reading, options) : null);
        }
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

                // The same sentence the pop-up shows, from the same function
                // and the same setting -- as its own sentence here, because
                // "Resets" is capitalised where it starts one.
                const when = limit.resetsAt
                    ? ` ${formatReset(limit.resetsAt, {format: this._resetFormat})}.`
                    : '';
                Main.notify(`${reading.displayName} usage at ${Math.round(limit.percent)}%`,
                    `${limit.label}.${when}`);
            }
        }
    }
}

// The button shows one figure; this is which. "session" is the default: the
// window you are working in right now is what a glance at the top bar is
// asking about, and the longer limits are a scroll of the eye away in the
// pop-up. A provider that meters no session falls through to its worst, which
// is what keeps the default meaningful for Antigravity as well as Claude.
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

// -1 means last, which insert_child_at_index already takes -- and taken button
// by button in order it still leaves them in the order they were asked for.
// Any other index is clamped, since what else is in the box is not ours to know.
function position(target, index, offset) {
    if (index < 0)
        return -1;
    const count = target ? target.get_n_children() : index + offset;
    return Math.min(index + offset, count);
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
