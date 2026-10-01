// The shape every provider is normalised into, and the wording the button and
// the pop-up put on it. Nothing here knows about Claude, or about HTTP: a
// provider hands back a Reading built from these, and the interface renders it
// without caring which service it came from.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Why a limit could not be read. The interface words each of these itself,
// because the fix differs: an absent tool is a thing to install, a stale login
// is a thing to run, and a failed request is a thing to wait out.
export const Status = {
    OK: 'ok',
    NO_CLI: 'no-cli',          // the provider's command-line tool is not installed
    SIGNED_OUT: 'signed-out',  // installed, but no stored login was found
    EXPIRED: 'expired',        // a login was found, but the service rejected it
    UNAVAILABLE: 'unavailable', // the request failed, or came back unreadable
    UNSUPPORTED: 'unsupported', // signed in, but this login has no limits to show
};

export const Severity = {
    NORMAL: 'normal',
    WARNING: 'warning',
    CRITICAL: 'critical',
};

// One bar in the pop-up: a percentage, when it resets, and whether the provider
// says this is the limit currently in force.
export class Limit {
    constructor({id, label, percent, severity = Severity.NORMAL, resetsAt = null, active = false, scoped = false, detail = null}) {
        this.id = id;
        this.label = label;
        this.percent = clampPercent(percent);
        this.severity = severity;
        this.resetsAt = resetsAt;   // GLib.DateTime in UTC, or null when open-ended
        this.active = active;
        this.scoped = scoped;       // metered per model rather than per account
        this.detail = detail;       // e.g. a spend figure, shown under the bar
    }
}

// What one provider knows right now -- either figures, or why there are none.
// A Reading is immutable; a fresh poll builds a new one.
export class Reading {
    constructor({providerId, displayName, status, plan = null, limits = [], breakdown = [], credits = null, message = null, cli = null}) {
        this.providerId = providerId;
        this.displayName = displayName;
        this.cli = cli;             // the tool to name when telling the user to sign in
        this.status = status;
        this.plan = plan;
        this.limits = limits;
        this.breakdown = breakdown; // [{label, percent}] -- where the week went
        this.credits = credits;     // {percent, label, detail?} for paid-for extra usage;
                                    // percent is null when it is switched off
        this.message = message;     // the provider's own words, when it has some
        this.panelEligible = true;  // may this one supply the figure on the button
        this.at = GLib.DateTime.new_now_utc();
    }

    get ok() {
        return this.status === Status.OK;
    }

    // The limit that will stop you first, which is the one worth putting on the
    // button. A provider may mark one active; a higher percentage still wins,
    // because that is the one about to run out.
    get worst() {
        let worst = null;
        for (const limit of this.limits) {
            if (!worst || limit.percent > worst.percent)
                worst = limit;
        }
        return worst;
    }

    find(predicate) {
        return this.limits.find(predicate) ?? null;
    }
}

// Number(null) is 0, Number(true) is 1, and Number('') is 0. Any of those
// passed through a percentage field would put a confident, wrong figure on the
// button -- and for a provider that reports what is *left* rather than what is
// used, a null would read as a limit that is fully spent. Only a real number
// counts; anything else means the row is dropped, because showing nothing is
// always better than showing a number that is not true.
export function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, n));
}

// Percentages are the backstop for a provider that sends no severity of its
// own, and they also override one that is behind the thresholds the user set:
// whichever reading is worse is the one shown.
export function severityFor(percent, {warn, critical}, reported = Severity.NORMAL) {
    const byPercent = percent >= critical
        ? Severity.CRITICAL
        : percent >= warn ? Severity.WARNING : Severity.NORMAL;
    const rank = {[Severity.NORMAL]: 0, [Severity.WARNING]: 1, [Severity.CRITICAL]: 2};
    return (rank[reported] ?? 0) > rank[byPercent] ? reported : byPercent;
}

// ---- when a limit resets ----------------------------------------------------

// The four ways of wording a reset, as the `reset-format` key spells them.
// `auto` is the default because it is what Claude Code's own /usage panel does:
// a countdown while the reset is near, a wall-clock time once a duration has
// stopped meaning anything.
export const ResetFormat = {
    AUTO: 'auto',
    RELATIVE: 'relative',
    ABSOLUTE: 'absolute',
    BOTH: 'both',
};

// Where `auto` turns over. A day out, "in 23 hours" is a figure you have to do
// arithmetic on; "Tue 3:00 PM" is one you can act on.
const AUTO_RELATIVE_MINUTES = 24 * 60;

const DESKTOP_INTERFACE = 'org.gnome.desktop.interface';

// "Resets in 1 hr 1 min", "Resets Tue 3:00 PM", "Resets now" -- Claude Code's
// own wording, down to the abbreviations, because these are Claude Code's
// figures and the button is not meant to look like a second opinion. Plain
// English, as the rest of these extensions are: nothing here is translated yet,
// and keeping this module free of the shell's gettext is what lets
// scripts/providers.js import it outside the shell.
//
// `now`, `clock` and `timezone` exist so the parser checks can pin the wording
// against a fixed moment in a fixed place. Nothing that ships passes them, and
// each falls back to the real thing.
export function formatReset(resetsAt, {format = ResetFormat.AUTO, now = null, clock = null, timezone = null} = {}) {
    if (!resetsAt)
        return null;

    const at = now ?? GLib.DateTime.new_now_utc();
    const seconds = resetsAt.difference(at) / GLib.TIME_SPAN_SECOND;
    if (seconds <= 0)
        return 'Resets now';

    // Under a minute still has to say something, and "in 0 min" is not it.
    const minutes = Math.max(1, Math.round(seconds / 60));
    const relative = `Resets in ${howLong(minutes)}`;
    if (format === ResetFormat.RELATIVE)
        return relative;

    // The local calendar is the one thing here that can fail. When it does the
    // countdown is still true, so that is what is shown.
    const wallClock = wallClockAt(resetsAt, at, clock, timezone);
    if (!wallClock)
        return relative;

    switch (format) {
    case ResetFormat.ABSOLUTE:
        return `Resets ${wallClock}`;
    case ResetFormat.BOTH:
        return `${relative} (${wallClock})`;
    default:
        return minutes < AUTO_RELATIVE_MINUTES ? relative : `Resets ${wallClock}`;
    }
}

// "45 min", "1 hr 1 min", "6 days". Past an hour the minutes still matter --
// they are the difference between waiting and going to do something else --
// and past a day they no longer do.
function howLong(minutes) {
    if (minutes < 60)
        return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24)
        return rest ? `${hours} hr ${rest} min` : `${hours} hr`;

    return plural(Math.round(hours / 24), 'day');
}

// "Tue 3:00 PM", or bare "3:00 PM" when the reset is later today: a day name on
// something happening this afternoon reads as a different day. The clock is the
// desktop's own 12/24-hour setting, because that is the clock the user is
// already reading at the other end of the top bar.
function wallClockAt(resetsAt, now, clock, timezone) {
    const local = timezone ? resetsAt.to_timezone(timezone) : resetsAt.to_local();
    const here = timezone ? now.to_timezone(timezone) : now.to_local();
    if (!local || !here)
        return null;

    const time = (clock ?? desktopClock()) === '12h'
        ? local.format('%-I:%M %p')
        : local.format('%H:%M');
    if (!time)
        return null;

    const today = local.get_year() === here.get_year() &&
        local.get_day_of_year() === here.get_day_of_year();
    return today ? time : `${local.format('%a')} ${time}`;
}

// Looked up once and then read on every call: building the Gio.Settings is what
// costs something, and the value can change while the extension is running.
// Anything going wrong falls back to a 24-hour clock rather than throwing -- a
// reset time in the wrong half of the day is still better than no pop-up.
let clockSettings = null;
let clockSettingsLookedUp = false;

function desktopClock() {
    if (!clockSettingsLookedUp) {
        clockSettingsLookedUp = true;
        try {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup(DESKTOP_INTERFACE, true);
            clockSettings = schema ? new Gio.Settings({settings_schema: schema}) : null;
        } catch {
            clockSettings = null;
        }
    }

    try {
        return clockSettings?.get_string('clock-format') === '12h' ? '12h' : '24h';
    } catch {
        return '24h';
    }
}

function plural(n, unit) {
    return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

// ---- the rest of the wording ------------------------------------------------

// The button's own text. Kept short on purpose: it sits in the top bar beside
// the clock, so it is a percentage and nothing else.
export function formatPercent(percent) {
    return `${Math.round(percent)}%`;
}

// Where a period's usage came from, when that is worth a line at all.
//
// One surviving row is 100% by definition -- every bit of the week came from
// one place -- so it reports nothing, and sitting directly under a row that IS
// a limit it reads as a second limit sitting at 100%. So it takes two rows, and
// it leads with where the usage went rather than with a percentage.
//
// The rule lives here rather than in a provider: providers go on reporting
// everything they know, as the rest of them do, and this is the wording the
// pop-up puts on it.
export function formatBreakdown(rows) {
    if (!Array.isArray(rows) || rows.length < 2)
        return null;
    const parts = rows.map(row => `${row.label} ${formatPercent(row.percent)}`);
    return `Where this week went: ${parts.join(' · ')}`;
}
