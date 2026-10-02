// Written from the openai/codex source and not yet run against a live account
// (issue #8). The endpoint is the one Codex's own /status reads.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Limit, Status, numberOrNull} from '../usage.js';
import * as Log from '../log.js';
import {detect, failureReading, readText, reading, unknownShapeReading} from './common.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CLI = 'codex';

const USER_AGENT = 'codex_cli_rs';

// The response does not name its windows, so they are known by their length.
const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const CodexProvider = {
    id: 'codex',
    displayName: 'Codex',
    cli: CLI,
    cliName: 'the Codex CLI',
    icon: 'codex-symbolic',

    capabilities: {
        perModel: true,     // additional_rate_limits[], one per metered model
        breakdown: false,   // the response says nothing about where usage went
        credits: true,      // credits{}
    },

    detect() {
        return detect(CLI);
    },

    credentialsFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([codexHome(), 'auth.json']));
    },

    async read(http, cancellable = null) {
        const auth = readCredentials();
        if (!auth) {
            return reading(this, {status: Status.SIGNED_OUT});
        }

        if (!auth.accessToken) {
            return reading(this, {
                status: Status.UNSUPPORTED,
                message: 'Signed in with an API key, which is billed per request rather than against subscription limits.',
            });
        }

        if (auth.expired) {
            return reading(this, {status: Status.EXPIRED});
        }

        const headers = {
            'Authorization': `Bearer ${auth.accessToken}`,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
        };
        if (auth.accountId)
            headers['ChatGPT-Account-ID'] = auth.accountId;

        let body;
        try {
            body = await http.getJson(USAGE_URL, headers, cancellable);
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum)
                throw e;   // cancelled
            return failureReading(this, e, auth.plan);
        }

        try {
            return this._parse(body, auth);
        } catch (e) {
            return unknownShapeReading(this, e, auth.plan);
        }
    },

    _parse(body, auth) {
        const limits = [];

        const rate = body?.rate_limit;
        pushWindow(limits, rate?.primary_window, {fallbackId: 'primary'});
        pushWindow(limits, rate?.secondary_window, {fallbackId: 'secondary'});

        // Keyed on the model, not the position: notifications remember the id.
        const extra = Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : [];
        extra.forEach((entry, index) => {
            const name = entry?.normal_model_slug || entry?.limit_name || entry?.metered_feature || null;
            const key = name ?? `bucket${index}`;
            const detail = entry?.rate_limit;
            pushWindow(limits, detail?.primary_window,
                {fallbackId: `model:${key}`, scoped: true, modelName: name});
            pushWindow(limits, detail?.secondary_window,
                {fallbackId: `model:${key}:secondary`, scoped: true, modelName: name});
        });

        if (!limits.length)
            throw new Error('no windows in the response');

        return reading(this, {
            status: Status.OK,
            plan: planLabel(body?.plan_type) ?? auth.plan,
            limits,
            credits: creditsFrom(body),
        });
    },
};

function pushWindow(limits, window, {fallbackId, scoped = false, modelName = null}) {
    const percent = numberOrNull(window?.used_percent);
    if (percent === null)
        return;

    const seconds = numberOrNull(window?.limit_window_seconds);
    const base = windowLabel(seconds);
    limits.push(new Limit({
        // The shared ids let primary-limit find the session or the week here too.
        id: scoped ? fallbackId : canonicalId(seconds) ?? fallbackId,
        label: modelName ? `${base} · ${modelName}` : base,
        percent,
        resetsAt: resetTime(window),
        scoped,
    }));
}

function canonicalId(seconds) {
    if (seconds === null)
        return null;
    if (Math.abs(seconds - SESSION_WINDOW_SECONDS) < 60 * 60)
        return 'session';
    if (Math.abs(seconds - WEEK_WINDOW_SECONDS) < 12 * 60 * 60)
        return 'weekly_all';
    return null;
}

function windowLabel(seconds) {
    if (seconds === null || seconds <= 0)
        return 'Current limit';
    if (Math.abs(seconds - SESSION_WINDOW_SECONDS) < 60 * 60)
        return 'Current session';
    if (Math.abs(seconds - WEEK_WINDOW_SECONDS) < 12 * 60 * 60)
        return 'This week';

    const hours = Math.round(seconds / 3600);
    if (hours < 48)
        return `Last ${hours} hours`;
    return `Last ${Math.round(hours / 24)} days`;
}

// Absolute reset only: one derived from reset_after_seconds drifts per poll and
// would notify again every time.
function resetTime(window) {
    const at = numberOrNull(window?.reset_at);
    if (at === null || at <= 0)
        return null;
    return GLib.DateTime.new_from_unix_utc(at);
}

// A balance is not a share of anything, so the row has no bar (percent null).
function creditsFrom(body) {
    const credits = body?.credits;
    if (!credits || credits.has_credits === false)
        return null;
    if (credits.unlimited === true)
        return {percent: null, label: 'Credits · unlimited'};

    // A string in the upstream types.
    const balance = credits.balance;
    if (typeof balance !== 'string' && typeof balance !== 'number')
        return null;
    const amount = Number(balance);
    if (!Number.isFinite(amount) || amount <= 0)
        return null;
    return {percent: null, label: `Credits · ${amount} left`};
}

function planLabel(planType) {
    if (typeof planType !== 'string' || !planType || planType === 'unknown')
        return null;
    return planType.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// As the CLI does: CODEX_HOME when set and non-empty.
function codexHome() {
    const home = GLib.getenv('CODEX_HOME');
    if (home)
        return home;
    return GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

// Read fresh every poll and never kept. A login kept in the keyring reads as signed out.
function readCredentials() {
    const contents = readText(CodexProvider.credentialsFile(), 'Codex credentials');
    if (contents === null)
        return null;

    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return null;   // half-written; the file monitor reads again
    }

    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null;

    // An API-key login is signed in but has no subscription windows.
    if (!accessToken)
        return parsed?.OPENAI_API_KEY ? {accessToken: null} : null;

    const claims = jwtClaims(accessToken);
    const authClaims = claims?.['https://api.openai.com/auth'];

    return {
        accessToken,
        accountId: typeof tokens?.account_id === 'string' && tokens.account_id
            ? tokens.account_id
            : authClaims?.chatgpt_account_id ?? null,
        plan: planLabel(authClaims?.chatgpt_plan_type),
        expired: isExpired(claims),
    };
}

// The token is a JWT; if it cannot be read, the request decides.
function jwtClaims(token) {
    try {
        const payload = token.split('.')[1];
        if (!payload)
            return null;
        // base64url without padding, to the base64 GLib reads.
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
            .padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
        return JSON.parse(new TextDecoder().decode(GLib.base64_decode(padded)));
    } catch (e) {
        Log.debug(`Could not read the Codex token's claims: ${e.message}`);
        return null;
    }
}

function isExpired(claims) {
    const exp = Number(claims?.exp);
    if (!Number.isFinite(exp))
        return false;   // unknown expiry: the request decides
    return exp * 1000 <= Date.now();
}
