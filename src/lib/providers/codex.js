// OpenAI Codex, by way of the Codex CLI's own login.
//
// *** NOT VERIFIED AGAINST A RUNNING CLI. *** Everything here was read out of
// the openai/codex source rather than observed: the Codex CLI is not installed
// on the machine this was written on, so no request has ever been made and no
// response has ever been parsed. Treat the field names as well-sourced but
// unproven, and see the repository issue tracking this.
//
// Codex's own /status and /usage read GET /backend-api/wham/usage with the
// access token stored at sign-in -- a plain read with no body, which the
// upstream source describes as being for "passive account usage readers". The
// per-window figures also ride along as x-codex-* headers on ordinary model
// calls, but those cost a request against the very limit being measured, so
// this only ever uses the dedicated endpoint.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Limit, Reading, Status, severityFor} from '../usage.js';
import * as Log from '../log.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CLI = 'codex';

// The CLI identifies itself this way. Whether the service cares is unknown;
// sending it means this looks like the tool whose login it is rather than
// something unfamiliar.
const USER_AGENT = 'codex_cli_rs';

// A rolling window is labelled by its own length, since the response does not
// name its windows. These are the two lengths the plans use today; anything
// else is described by its duration rather than guessed at.
const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const CodexProvider = {
    id: 'codex',
    displayName: 'Codex',
    cli: CLI,
    cliName: 'the Codex CLI',

    capabilities: {
        perModel: true,     // additional_rate_limits[], one per metered model
        breakdown: false,   // the response says nothing about where usage went
        credits: true,      // credits{}
    },

    detect() {
        return GLib.find_program_in_path(CLI) !== null;
    },

    credentialsFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([codexHome(), 'auth.json']));
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

        // An API-key login is a real login with no subscription behind it, so
        // there are no windows to show. Saying that is more use than an error.
        if (!auth.accessToken) {
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: Status.UNSUPPORTED,
                message: 'Signed in with an API key, which is billed per request rather than against subscription limits.',
            });
        }

        // The token carries its own expiry, so a dead one is known without
        // spending a request to be told so.
        if (auth.expired) {
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: Status.EXPIRED,
            });
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
                throw e;   // cancelled: the caller is disabling or superseding us
            const status = Number.isFinite(e?.status) ? e.status : 0;
            const expired = status === 401 || status === 403;
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: expired ? Status.EXPIRED : Status.UNAVAILABLE,
                plan: auth.plan,
                message: expired ? null : e.message,
            });
        }

        try {
            return this._parse(body, auth, thresholds);
        } catch (e) {
            Log.warn(`Could not read Codex's usage response: ${e.message}`);
            return new Reading({
                providerId: this.id,
                displayName: this.displayName,
                status: Status.UNAVAILABLE,
                plan: auth.plan,
                message: 'The service answered in a shape this version does not know.',
            });
        }
    },

    _parse(body, auth, thresholds) {
        const limits = [];

        const rate = body?.rate_limit;
        pushWindow(limits, 'primary', rate?.primary_window, thresholds, false);
        pushWindow(limits, 'secondary', rate?.secondary_window, thresholds, false);

        // Per-model buckets, each with a rate limit of the same shape.
        const extra = Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : [];
        for (const entry of extra) {
            const name = entry?.normal_model_slug || entry?.limit_name || entry?.metered_feature;
            const detail = entry?.rate_limit;
            pushWindow(limits, `model:${name ?? limits.length}`, detail?.primary_window, thresholds, true, name);
            pushWindow(limits, `model:${name ?? limits.length}:secondary`, detail?.secondary_window, thresholds, true, name);
        }

        if (!limits.length)
            throw new Error('no windows in the response');

        return new Reading({
            providerId: this.id,
            displayName: this.displayName,
            status: Status.OK,
            plan: planLabel(body?.plan_type) ?? auth.plan,
            limits,
            credits: creditsFrom(body),
        });
    },
};

// ---- the response -----------------------------------------------------------

function pushWindow(limits, id, window, thresholds, scoped, modelName = null) {
    const percent = Number(window?.used_percent);
    if (!Number.isFinite(percent))
        return;

    const seconds = Number(window?.limit_window_seconds);
    const base = windowLabel(seconds);
    limits.push(new Limit({
        id,
        label: modelName ? `${base} · ${modelName}` : base,
        percent,
        severity: severityFor(percent, thresholds),
        resetsAt: resetTime(window),
        scoped,
    }));
}

// The payload never names its windows, so the name comes from the length. The
// two known lengths get the same wording as the other providers; anything else
// is described rather than guessed at, so a plan with different windows still
// reads correctly.
function windowLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
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

// reset_at is Unix epoch seconds; reset_after_seconds is the same moment said
// relatively, and is the fallback when the absolute one is missing.
function resetTime(window) {
    const at = Number(window?.reset_at);
    if (Number.isFinite(at) && at > 0)
        return GLib.DateTime.new_from_unix_utc(at);

    const after = Number(window?.reset_after_seconds);
    if (Number.isFinite(after) && after > 0)
        return GLib.DateTime.new_now_utc().add_seconds(after);
    return null;
}

function creditsFrom(body) {
    const credits = body?.credits;
    if (!credits)
        return null;
    if (credits.unlimited === true)
        return {percent: 0, label: 'Credits · unlimited'};

    const balance = Number(credits.balance);
    if (!Number.isFinite(balance))
        return null;
    return {percent: 0, label: `Credits · ${balance} left`};
}

function planLabel(planType) {
    if (typeof planType !== 'string' || !planType || planType === 'unknown')
        return null;
    return planType.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ---- the stored login -------------------------------------------------------

// CODEX_HOME wins if it is set and non-empty, as the CLI itself does.
function codexHome() {
    const home = GLib.getenv('CODEX_HOME');
    if (home)
        return home;
    return GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

// Read fresh every poll and never kept. Note that the CLI can be configured to
// keep its login in the secret service instead, in which case there is no file
// and this reports as signed out -- the same gap the Claude provider has.
function readCredentials() {
    let contents;
    try {
        const [ok, bytes] = CodexProvider.credentialsFile().load_contents(null);
        if (!ok)
            return null;
        contents = new TextDecoder().decode(bytes);
    } catch (e) {
        Log.debug(`No Codex credentials to read: ${e.message}`);
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return null;   // a half-written file; the monitor will bring us back
    }

    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null;

    // An API-key login is signed in but has no windows; it is told apart from
    // being signed out entirely by there being a key at all.
    if (!accessToken)
        return parsed?.OPENAI_API_KEY ? {accessToken: null} : null;

    const claims = jwtClaims(accessToken);
    const authClaims = claims?.['https://api.openai.com/auth'];

    return {
        accessToken,
        // The account id is usually beside the token, and otherwise inside it.
        accountId: typeof tokens?.account_id === 'string' && tokens.account_id
            ? tokens.account_id
            : authClaims?.chatgpt_account_id ?? null,
        plan: planLabel(authClaims?.chatgpt_plan_type),
        expired: isExpired(claims),
    };
}

// The access token is a JWT, so its expiry is readable without asking anyone.
// Any trouble reading it means falling through to the request, which will say.
function jwtClaims(token) {
    try {
        const payload = token.split('.')[1];
        if (!payload)
            return null;
        // JWTs use base64url and drop the padding; GLib wants neither.
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
        return false;   // unknown expiry: let the request decide
    return exp * 1000 <= Date.now();
}
