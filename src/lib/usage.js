import GLib from 'gi://GLib';

export const Status = {
    OK: 'ok',
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

export class Limit {
    constructor({id, label, percent, severity = Severity.NORMAL, resetsAt = null, active = false, scoped = false}) {
        this.id = id;
        this.label = label;
        this.percent = Math.max(0, Math.min(100, percent));
        this.severity = severity;   // the service's own; applyOptions() adds the user's thresholds
        this.resetsAt = resetsAt;   // GLib.DateTime in UTC, or null when open-ended
        this.active = active;
        this.scoped = scoped;       // metered per model rather than per account
    }
}

// What one provider knows right now: figures, or why there are none.
export class Reading {
    constructor({providerId, displayName, status, plan = null, limits = [], breakdown = [], credits = null, message = null, cli = null}) {
        this.providerId = providerId;
        this.displayName = displayName;
        this.cli = cli;             // the tool to name when telling the user to sign in
        this.status = status;
        this.plan = plan;
        this.limits = limits;
        this.breakdown = breakdown; // [{label, percent}] -- where the week went
        this.credits = credits;     // {percent, label, detail?}; percent null when switched off
        this.message = message;     // the provider's own words, when it has some
        this.at = GLib.DateTime.new_now_utc();
    }

    get ok() {
        return this.status === Status.OK;
    }

    get worst() {
        let worst = null;
        for (const limit of this.limits) {
            if (!worst || limit.percent > worst.percent)
                worst = limit;
        }
        return worst;
    }
}

// Number(null), Number(true) and Number('') are numbers; a row without a real
// one is dropped rather than shown as a wrong figure.
export function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value) {
    return typeof value === 'string' && value ? value : null;
}

// The worse of the service's own severity and the user's thresholds.
export function severityFor(percent, {warn, critical}, reported = Severity.NORMAL) {
    const byPercent = percent >= critical
        ? Severity.CRITICAL
        : percent >= warn ? Severity.WARNING : Severity.NORMAL;
    const rank = {[Severity.NORMAL]: 0, [Severity.WARNING]: 1, [Severity.CRITICAL]: 2};
    return (rank[reported] ?? 0) > rank[byPercent] ? reported : byPercent;
}

export const ResetFormat = {
    AUTO: 'auto',
    RELATIVE: 'relative',
    ABSOLUTE: 'absolute',
    BOTH: 'both',
};

// Where `auto` turns from a countdown to a wall-clock time.
const AUTO_RELATIVE_MINUTES = 24 * 60;

// Claude Code's wording ("Resets in 1 hr 1 min", "Resets Tue 3:00 PM"). `clock`
// is the desktop's '12h' or '24h'; `now` and `timezone` are for scripts/parsers.js.
export function formatReset(resetsAt, {format = ResetFormat.AUTO, now = null, clock = null, timezone = null} = {}) {
    if (!resetsAt)
        return null;

    const at = now ?? GLib.DateTime.new_now_utc();
    const seconds = resetsAt.difference(at) / GLib.TIME_SPAN_SECOND;
    if (seconds <= 0)
        return 'Resets now';

    const minutes = Math.max(1, Math.round(seconds / 60));
    const relative = `Resets in ${howLong(minutes)}`;
    if (format === ResetFormat.RELATIVE)
        return relative;

    const wallClock = wallClockAt(resetsAt, at, clock, timezone);
    switch (format) {
    case ResetFormat.ABSOLUTE:
        return `Resets ${wallClock}`;
    case ResetFormat.BOTH:
        return `${relative} (${wallClock})`;
    default:
        return minutes < AUTO_RELATIVE_MINUTES ? relative : `Resets ${wallClock}`;
    }
}

// "45 min", "1 hr 1 min", "6 days".
function howLong(minutes) {
    if (minutes < 60)
        return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24)
        return rest ? `${hours} hr ${rest} min` : `${hours} hr`;

    return plural(Math.round(hours / 24), 'day');
}

// "Tue 3:00 PM", "3:00 PM" when the reset is later today, and the date as well
// past the next six days, where a day name alone would read as this week's.
function wallClockAt(resetsAt, now, clock, timezone) {
    const local = timezone ? resetsAt.to_timezone(timezone) : resetsAt.to_local();
    const here = timezone ? now.to_timezone(timezone) : now.to_local();
    const time = clock === '12h'
        ? local.format('%-I:%M %p')
        : local.format('%H:%M');

    const today = local.get_year() === here.get_year() &&
        local.get_day_of_year() === here.get_day_of_year();
    if (today)
        return time;
    const thisWeek = local.format('%Y%j') <= here.add_days(6).format('%Y%j');
    return `${local.format(thisWeek ? '%a' : '%a %-d %b')} ${time}`;
}

function plural(n, unit) {
    return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function formatPercent(percent) {
    return `${Math.round(percent)}%`;
}

// Two rows at least: a single one is 100% and would read as another limit.
export function formatBreakdown(rows) {
    if (rows.length < 2)
        return null;
    const parts = rows.map(row => `${row.label} ${formatPercent(row.percent)}`);
    return `Where this week went: ${parts.join(' · ')}`;
}
