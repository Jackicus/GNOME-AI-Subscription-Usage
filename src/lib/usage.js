// The shape every provider is normalised into, and the wording the button and
// the pop-up put on it. Nothing here knows about Claude, or about HTTP: a
// provider hands back a Reading built from these, and the interface renders it
// without caring which service it came from.

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
        this.credits = credits;     // {percent, label} for paid-for extra usage
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

// "in 4 hours", "in 22 minutes", "now" -- the coarse wording a glance wants,
// rather than a countdown. Plain English, as the rest of these extensions are:
// nothing here is translated yet, and keeping this module free of the shell's
// gettext is what lets scripts/providers.js import it outside the shell.
export function formatReset(resetsAt) {
    if (!resetsAt)
        return null;
    const seconds = resetsAt.difference(GLib.DateTime.new_now_utc()) / GLib.TIME_SPAN_SECOND;
    if (seconds <= 0)
        return 'resets now';

    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `resets in ${plural(minutes, 'minute')}`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) {
        // Past an hour the minutes still matter -- "in 4h 20m" is the
        // difference between waiting and going to do something else.
        return rest ? `resets in ${hours}h ${rest}m` : `resets in ${plural(hours, 'hour')}`;
    }

    const days = Math.round(hours / 24);
    return `resets in ${plural(days, 'day')}`;
}

function plural(n, unit) {
    return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

// The button's own text. Kept short on purpose: it sits in the top bar beside
// the clock, so it is a percentage and nothing else.
export function formatPercent(percent) {
    return `${Math.round(percent)}%`;
}
