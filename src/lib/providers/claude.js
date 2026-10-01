// Claude, by way of Claude Code's own login.
//
// Claude Code's `/usage` is a GET of /api/oauth/usage with the OAuth access
// token it stored at sign-in; this asks the same question with the same token
// and gets the same figures back, which is the point -- the button agrees with
// the terminal because it is not a second reckoning of anything.
//
// Two things about that token decide the shape of this file:
//
//   * It is short-lived, a few hours, and Claude Code refreshes it when it runs
//     and rewrites the file. So the file is read on every poll and the token is
//     never held between polls -- caching it would mean sending a stale one.
//
//   * Refreshing it rotates the refresh token. If this extension did that
//     refresh, Claude Code could be left holding a refresh token that has been
//     spent, which signs the user out of their terminal. So it never refreshes:
//     when the token is rejected it reports EXPIRED and asks the user to run
//     Claude Code, which refreshes it as a side effect of starting.
//
// The plan name comes from a second file, ~/.claude.json, for the reason given
// over readAccountTier(): the tier in the credentials is stamped there at
// sign-in and never rewritten, so on an upgraded account it is simply wrong.
// A file read rather than a second request -- the poll stays one HTTP call, and
// this still only ever reads what the tool already stored.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Limit, Reading, Severity, Status, numberOrNull, severityFor} from '../usage.js';
import * as Log from '../log.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// The beta header Claude Code sends with an OAuth token. This endpoint answers
// without it today, but it is sent anyway: looking exactly like the tool whose
// login this is means a tightening on the service's side does not single this
// out. A bad token gets a 401 here, which is what Status.EXPIRED maps.
const OAUTH_BETA = 'oauth-2025-04-20';

const CLI = 'claude';

// The kinds seen in the `limits` array, in the order they should be listed.
// Anything else is shown too, under a label made from its own name: the array
// is the service's own curated list for its usage screen, so a new entry in it
// is a real limit worth showing rather than something internal.
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped'];

// Claude Code's own words for these rows, so that the pop-up and the terminal
// name the same limit the same way. They are Claude's and no one else's: the
// other providers keep their own wording.
const KIND_LABELS = {
    session: '5-hour limit',
    weekly_all: 'Weekly · all models',
    weekly_scoped: 'Weekly',   // qualified by the model it is scoped to
};

export const ClaudeProvider = {
    id: 'claude',
    displayName: 'Claude',
    cli: CLI,
    cliName: 'Claude Code',
    icon: 'claude-symbolic',

    // What this provider can actually report, so the preferences only offer
    // switches it can honour.
    capabilities: {
        perModel: true,     // weekly_scoped rows, one per model
        breakdown: true,    // seven_day_breakdown
        credits: true,      // extra_usage / spend
    },

    detect() {
        return GLib.find_program_in_path(CLI) !== null;
    },

    // The file to watch: Claude Code rewriting it means the token was refreshed,
    // which is both a good moment to poll again and the thing that clears an
    // EXPIRED state.
    credentialsFile() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']));
    },

    // Claude Code's own account state, which is where the current plan is. Not
    // watched: it is read alongside the credentials on every poll.
    accountFile() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']));
    },

    async read(http, cancellable = null, thresholds = {warn: 80, critical: 95}) {
        const auth = readCredentials();
        if (!auth) {
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: Status.SIGNED_OUT,
            });
        }

        let body;
        try {
            body = await http.getJson(USAGE_URL, {
                'Authorization': `Bearer ${auth.accessToken}`,
                'anthropic-beta': OAUTH_BETA,
                'Accept': 'application/json',
            }, cancellable);
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum)
                throw e;   // cancelled: the caller is disabling or superseding us
            return this._failure(e, auth);
        }

        try {
            return this._parse(body, auth, thresholds);
        } catch (e) {
            // The response arrived but was not the shape we knew. Say the
            // figures are unavailable rather than showing a wrong number.
            Log.warn(`Could not read Claude's usage response: ${e.message}`);
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: Status.UNAVAILABLE,
                plan: planLabel(auth),
                message: 'The service answered in a shape this version does not know.',
            });
        }
    },

    _failure(e, auth) {
        // Read duck-typed rather than against HttpError, so that a provider
        // needs no import from the HTTP layer -- which is what keeps Soup out
        // of the import graph and lets prefs.js load this registry.
        const status = Number.isFinite(e?.status) ? e.status : 0;
        // 401 and 403 are the stored token being stale or withdrawn, which is
        // the one failure the user can do something about.
        const expired = status === 401 || status === 403;
        return new Reading({
            providerId: this.id,
            displayName: this.displayName,
            status: expired ? Status.EXPIRED : Status.UNAVAILABLE,
            plan: planLabel(auth),
            message: expired ? null : e.message,
        });
    },

    _parse(body, auth, thresholds) {
        const rows = Array.isArray(body?.limits) ? body.limits : null;
        const limits = rows?.length
            ? rows.map(row => limitFromRow(row, thresholds)).filter(l => l)
            : limitsFromWindows(body, thresholds);

        if (!limits.length)
            throw new Error('no limits in the response');

        limits.sort((a, b) => kindRank(a.id) - kindRank(b.id));

        return new Reading({
            providerId: this.id,
            displayName: this.displayName,
            status: Status.OK,
            plan: planLabel(auth),
            limits,
            breakdown: breakdownFrom(body),
            credits: creditsFrom(body, thresholds),
        });
    },
};

// ---- the response -----------------------------------------------------------

// `limits` is the modern shape, and the one Claude Code's own usage screen is
// built from: one row per limit, already carrying a percentage and a severity.
function limitFromRow(row, thresholds) {
    const kind = typeof row?.kind === 'string' ? row.kind : null;
    const percent = numberOrNull(row?.percent);
    if (!kind || percent === null)
        return null;

    return new Limit({
        id: kind,
        label: labelForRow(kind, row),
        percent,
        severity: severityFor(percent, thresholds, row.severity),
        resetsAt: parseTimestamp(row.resets_at),
        active: row.is_active === true,
        // Any scope at all means this row is metered against something
        // narrower than the account, which is the distinction the "per-model
        // limits" switch makes -- a row scoped by surface counts too, or the
        // switch could not hide it.
        scoped: !!row?.scope,
    });
}

function labelForRow(kind, row) {
    const base = KIND_LABELS[kind] ?? humanise(kind);
    // A scoped limit is only meaningful with its scope named: two rows both
    // saying "Weekly" at different percentages would read as a bug. The scope
    // is usually a model; a surface is the other shape seen.
    const scope = row?.scope?.model?.display_name ?? row?.scope?.surface?.display_name;
    return scope ? `${base} · ${scope}` : base;
}

// The older top-level windows, kept as a fallback in case `limits` goes away
// again. Same numbers, less metadata.
function limitsFromWindows(body, thresholds) {
    const windows = [
        ['session', KIND_LABELS.session, body?.five_hour, false],
        ['weekly_all', KIND_LABELS.weekly_all, body?.seven_day, false],
        ['weekly_opus', `${KIND_LABELS.weekly_scoped} · Opus`, body?.seven_day_opus, true],
        ['weekly_sonnet', `${KIND_LABELS.weekly_scoped} · Sonnet`, body?.seven_day_sonnet, true],
    ];

    const limits = [];
    for (const [id, label, window, scoped] of windows) {
        const percent = numberOrNull(window?.utilization);
        if (percent === null)
            continue;
        limits.push(new Limit({
            id,
            label,
            percent,
            severity: severityFor(percent, thresholds),
            resetsAt: parseTimestamp(window.resets_at),
            scoped,
        }));
    }
    return limits;
}

// Where the week went: Claude Code against chats against everything else. Only
// worth showing when something is actually in it.
function breakdownFrom(body) {
    const rows = body?.seven_day_breakdown?.rows;
    if (!Array.isArray(rows))
        return [];
    return rows
        .filter(row => Number(row?.percent) > 0 && typeof row?.display_name === 'string')
        .map(row => ({label: row.display_name, percent: Number(row.percent)}));
}

// Paid-for usage past the plan's limits. Absent for most accounts.
function creditsFrom(body, thresholds) {
    const extra = body?.extra_usage;
    if (!extra || typeof extra !== 'object')
        return null;

    // Turned off is still a reading, and saying so beats a switch in the
    // preferences that is on and draws nothing. It is all that can be said,
    // though: switched off, the service sends no balance and no limit, so
    // there is no bar and no figure -- only "off" and what has been spent.
    // `percent: null` is what tells the renderer to draw it that way.
    if (!extra.is_enabled) {
        const spent = money(body?.spend?.used);
        return {
            percent: null,
            severity: Severity.NORMAL,
            label: 'Extra usage · off',
            detail: spent ? `${spent} used` : null,
        };
    }

    // The figure and its severity must come from the same place, or a 0% bar
    // ends up coloured as a warning. spend.percent is the partner of
    // spend.severity; extra_usage.utilization is the fallback. With neither
    // there is no honest bar to draw, so there is no row.
    const percent = numberOrNull(body?.spend?.percent) ?? numberOrNull(extra.utilization);
    if (percent === null)
        return null;

    const spent = money(body?.spend?.used);
    return {
        percent,
        severity: severityFor(percent, thresholds, body?.spend?.severity),
        label: spent ? `Extra usage · ${spent} used` : 'Extra usage',
    };
}

function money(amount) {
    const minor = Number(amount?.amount_minor);
    if (!Number.isFinite(minor))
        return null;
    const exponent = Number.isFinite(Number(amount?.exponent)) ? Number(amount.exponent) : 2;
    const value = minor / Math.pow(10, exponent);
    const currency = typeof amount?.currency === 'string' ? amount.currency : '';
    return `${value.toFixed(exponent)} ${currency}`.trim();
}

function kindRank(id) {
    const index = KIND_ORDER.indexOf(id);
    return index === -1 ? KIND_ORDER.length : index;
}

// "weekly_all" -> "Weekly all". Only reached for a kind this version has not
// seen, so it is a readable last resort rather than a nice label.
function humanise(kind) {
    const words = kind.replace(/[_-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function parseTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    return GLib.DateTime.new_from_iso8601(value, null);
}

// ---- the stored login -------------------------------------------------------

// Read fresh every poll, and nothing from it is kept: the token is handed
// straight to the request and goes out of scope. Never logged, at any verbosity.
function readCredentials() {
    const file = ClaudeProvider.credentialsFile();
    let contents;
    try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        contents = new TextDecoder().decode(bytes);
    } catch (e) {
        // Not being signed in is the ordinary case here, not a fault: there is
        // no file until Claude Code has been logged into once.
        Log.debug(`No Claude credentials to read: ${e.message}`);
        return null;
    }

    try {
        const oauth = JSON.parse(contents)?.claudeAiOauth;
        if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken)
            return null;
        return {
            accessToken: oauth.accessToken,
            subscriptionType: oauth.subscriptionType ?? null,
            rateLimitTier: oauth.rateLimitTier ?? null,
            accountTier: readAccountTier(ClaudeProvider.accountFile()),
        };
    } catch {
        // A half-written file -- Claude Code refreshing the token as we read.
        // The next poll, which the file monitor is about to trigger, gets it.
        return null;
    }
}

// The plan, from the account state Claude Code keeps in ~/.claude.json.
//
// The tier in the credentials file is written when the login is created and is
// never rewritten, so an account that has since changed plan reports the plan
// it signed up on -- a Max 20x account reading as "Max 5x". This file carries
// its own `profileFetchedAt` and Claude Code refreshes it when it starts, so it
// is the current one. The usage response itself has no plan field at all, and a
// second request for one would cost a round trip on every poll.
//
// It is a largish file of things this extension has no business with, so only
// the tier is taken from it, nothing is kept, and nothing is ever written back.
// Absent, half-written, or simply without an `oauthAccount` -- Claude Code has
// been installed but never signed in -- are all ordinary, and each falls
// through to the credentials rather than throwing: a missing plan name is fine,
// a wrong one is not.
export function readAccountTier(file) {
    let contents;
    try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        contents = new TextDecoder().decode(bytes);
    } catch (e) {
        Log.debug(`No Claude account file to read: ${e.message}`);
        return null;
    }

    try {
        const account = JSON.parse(contents)?.oauthAccount;
        // The limits are metered against the organisation, so its tier is the
        // one that governs; userRateLimitTier is what a personal account has.
        return tierString(account?.organizationRateLimitTier) ??
            tierString(account?.userRateLimitTier);
    } catch {
        // Half-written, or not the shape this version knows.
        return null;
    }
}

function tierString(value) {
    return typeof value === 'string' && value ? value : null;
}

// "default_claude_max_5x" -> "Max (5x)", which is how Claude Code's own usage
// panel writes it. Cosmetic, and dropped entirely if no source yields a shape
// we recognise, since a wrong plan name is worse than none. The live tier
// first, then the one frozen into the credentials at sign-in, then the bare
// subscription name.
export function planLabel(auth) {
    const tier = tierString(auth?.accountTier) ?? tierString(auth?.rateLimitTier);
    if (tier) {
        const cleaned = tier.replace(/^default_claude_/, '').replace(/_/g, ' ').trim();
        if (cleaned) {
            // The multiplier is bracketed and the rest is left alone, so a tier
            // that carries no multiplier -- "pro" -- still comes out as "Pro".
            return cleaned.replace(/^\w/, c => c.toUpperCase())
                .replace(/ (\d+x)$/, ' ($1)');
        }
    }
    const type = auth?.subscriptionType;
    if (typeof type === 'string' && type)
        return type.replace(/^\w/, c => c.toUpperCase());
    return null;
}
