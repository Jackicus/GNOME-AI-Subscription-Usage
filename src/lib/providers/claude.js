// The request Claude Code's /usage makes, with its stored token. The token is
// never refreshed here: that rotates the refresh token and signs Claude Code out.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Limit, Status, numberOrNull, stringOrNull} from '../usage.js';
import {failureReading, humanise, parseTimestamp, readJson, reading, unknownShapeReading} from './common.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Not required today; sent to look exactly like Claude Code.
const OAUTH_BETA = 'oauth-2025-04-20';

// Listing order; an unknown kind is listed last under its own name.
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped'];

// Claude Code's own words for these rows.
const KIND_LABELS = {
    session: '5-hour limit',
    weekly_all: 'Weekly · all models',
    weekly_scoped: 'Weekly',   // qualified by the model it is scoped to
};

export const ClaudeProvider = {
    id: 'claude',
    displayName: 'Claude',
    cli: 'claude',
    cliName: 'Claude Code',
    icon: 'claude-symbolic',

    capabilities: {
        perModel: true,     // weekly_scoped rows, one per model
        breakdown: true,    // seven_day_breakdown
        credits: true,      // extra_usage / spend
    },

    credentialsFile() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']));
    },

    async read(http, cancellable = null) {
        const auth = readCredentials();
        if (!auth) {
            return reading(this, {status: Status.SIGNED_OUT});
        }

        let body;
        try {
            body = await http.getJson(USAGE_URL, {
                'Authorization': `Bearer ${auth.accessToken}`,
                'anthropic-beta': OAUTH_BETA,
                'Accept': 'application/json',
            }, cancellable);
        } catch (e) {
            return failureReading(this, e, planLabel(auth));
        }

        try {
            return this._parse(body, auth);
        } catch (e) {
            return unknownShapeReading(this, e, planLabel(auth));
        }
    },

    _parse(body, auth) {
        const rows = Array.isArray(body?.limits) ? body.limits : null;
        const limits = rows?.length
            ? rows.map(limitFromRow).filter(l => l)
            : limitsFromWindows(body);

        if (!limits.length)
            throw new Error('no limits in the response');

        limits.sort((a, b) => kindRank(a.id) - kindRank(b.id));

        return reading(this, {
            status: Status.OK,
            plan: planLabel(auth),
            limits,
            breakdown: breakdownFrom(body),
            credits: creditsFrom(body),
        });
    },
};

function limitFromRow(row) {
    const kind = stringOrNull(row?.kind);
    const percent = numberOrNull(row?.percent);
    if (!kind || percent === null)
        return null;

    return new Limit({
        id: kind,
        label: labelForRow(kind, row),
        percent,
        severity: row.severity,
        resetsAt: parseTimestamp(row.resets_at),
        active: row.is_active === true,
        // Scoped by model or by surface: either way the per-model switch hides it.
        scoped: !!row.scope,
    });
}

function labelForRow(kind, row) {
    const base = KIND_LABELS[kind] ?? humanise(kind);
    const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
    return scope ? `${base} · ${scope}` : base;
}

// The older top-level windows, in case `limits` goes away again.
function limitsFromWindows(body) {
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
            resetsAt: parseTimestamp(window.resets_at),
            scoped,
        }));
    }
    return limits;
}

function breakdownFrom(body) {
    const rows = body?.seven_day_breakdown?.rows;
    if (!Array.isArray(rows))
        return [];
    return rows
        .filter(row => Number(row?.percent) > 0 && typeof row?.display_name === 'string')
        .map(row => ({label: row.display_name, percent: Number(row.percent)}));
}

function creditsFrom(body) {
    const extra = body?.extra_usage;
    if (!extra || typeof extra !== 'object')
        return null;

    // Switched off, the service sends no figure: a row with no bar (percent null).
    if (!extra.is_enabled) {
        const spent = money(body?.spend?.used);
        return {
            percent: null,
            label: 'Extra usage · off',
            detail: spent ? `${spent} used` : null,
        };
    }

    // spend.percent goes with spend.severity, or a 0% bar is coloured as a warning.
    const percent = numberOrNull(body?.spend?.percent) ?? numberOrNull(extra.utilization);
    if (percent === null)
        return null;

    const spent = money(body?.spend?.used);
    return {
        percent,
        severity: body?.spend?.severity,
        label: spent ? `Extra usage · ${spent} used` : 'Extra usage',
    };
}

function money(amount) {
    const minor = Number(amount?.amount_minor);
    if (!Number.isFinite(minor))
        return null;
    const exponent = Number.isFinite(Number(amount?.exponent)) ? Number(amount.exponent) : 2;
    const value = minor / Math.pow(10, exponent);
    const currency = stringOrNull(amount?.currency) ?? '';
    return `${value.toFixed(exponent)} ${currency}`.trim();
}

function kindRank(id) {
    const index = KIND_ORDER.indexOf(id);
    return index === -1 ? KIND_ORDER.length : index;
}

// Read fresh every poll and never kept or logged.
function readCredentials() {
    const oauth = readJson(ClaudeProvider.credentialsFile(), 'Claude credentials')?.claudeAiOauth;
    const accessToken = stringOrNull(oauth?.accessToken);
    if (!accessToken)
        return null;
    return {
        accessToken,
        subscriptionType: oauth.subscriptionType ?? null,
        rateLimitTier: oauth.rateLimitTier ?? null,
        accountTier: readAccountTier(Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']))),
    };
}

// The current plan, from ~/.claude.json: the credentials' tier is stamped at
// sign-in and never rewritten.
export function readAccountTier(file) {
    const account = readJson(file, 'Claude account file')?.oauthAccount;
    return stringOrNull(account?.organizationRateLimitTier) ?? stringOrNull(account?.userRateLimitTier);
}

// "default_claude_max_5x" -> "Max (5x)", as Claude Code writes it.
export function planLabel(auth) {
    const tier = stringOrNull(auth?.accountTier) ?? stringOrNull(auth?.rateLimitTier);
    const plan = tier && humanise(tier.replace(/^default_claude_/, '')).replace(/ (\d+x)$/, ' ($1)');
    if (plan)
        return plan;
    const type = stringOrNull(auth?.subscriptionType);
    return type && humanise(type);
}
