// Google Antigravity, by way of the Antigravity CLI's own login.
//
// Antigravity keeps its login in the **secret service** rather than a file --
// the file beside it, ~/.gemini/antigravity-cli/antigravity-oauth-token, is a
// fallback the CLI only writes when there is no D-Bus session (a container, a
// headless host), and on an ordinary desktop it is stale. Reading the file
// first would serve a dead token on a perfectly healthy machine, so the keyring
// is tried first and the file only after.
//
// The figures take two requests: loadCodeAssist names the project the account's
// quota hangs off, and retrieveUserQuotaSummary returns the buckets. Both are
// POSTs, and both are reads -- the CLI's own /usage asks the same questions.
// The project id does not change, so it is kept for the life of the extension
// and only the second request is made on later polls.
//
// `agy -p /usage --output-format json` answers the same question without any of
// this, but it takes around eleven seconds and starts the user's MCP servers,
// which is far too heavy for something polled behind a panel button.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';

import {Limit, Status, numberOrNull} from '../usage.js';
import * as Log from '../log.js';
import {detect, failureReading, parseTimestamp, readText, reading} from './common.js';

const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

const CLI = 'agy';

// Not cosmetic: the service answers 403 to a user agent that does not begin
// with "antigravity".
const USER_AGENT = 'antigravity/cli (gnome-shell-extension-ai-usage)';

// The CLI stores its token with go-keyring, which uses the generic schema with
// service and username attributes. DONT_MATCH_NAME because the stored item
// carries go-keyring's schema name rather than one of ours.
const KEYRING_SCHEMA = new Secret.Schema(
    'org.freedesktop.Secret.Generic',
    Secret.SchemaFlags.DONT_MATCH_NAME,
    {
        service: Secret.SchemaAttributeType.STRING,
        username: Secret.SchemaAttributeType.STRING,
    });

const KEYRING_ATTRIBUTES = {service: 'gemini', username: 'antigravity'};

export const AntigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    cli: CLI,
    cliName: 'the Antigravity CLI (agy)',
    icon: 'antigravity-symbolic',

    capabilities: {
        // The summary's buckets are grouped by model family, but those groups
        // ARE the account's limits rather than extras beside a whole-account
        // one -- so there is nothing here that a "per-model" switch could hide
        // without hiding everything.
        perModel: false,
        breakdown: false,
        credits: false,
    },

    detect() {
        return detect(CLI);
    },

    // The fallback file only. The keyring cannot be watched this way, so a
    // refresh there is picked up by the next poll rather than at once.
    credentialsFile() {
        return Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_home_dir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token']));
    },

    async read(http, cancellable = null) {
        let auth;
        try {
            auth = await readCredentials(cancellable);
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum)
                throw e;
            Log.debug(`Could not read Antigravity's login: ${e.message}`);
            auth = null;
        }

        if (!auth)
            return this._reading({status: Status.SIGNED_OUT});
        if (auth.expired)
            return this._reading({status: Status.EXPIRED});

        const headers = {
            'Authorization': `Bearer ${auth.accessToken}`,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
        };

        try {
            const project = await this._project(http, headers, cancellable);
            if (!project)
                throw new Error('the account has no Code Assist project');

            const body = await http.postJson(QUOTA_URL, headers, {project}, cancellable);
            return this._parse(body);
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum)
                throw e;

            const failure = failureReading(this, e, auth.plan ?? this._plan);
            // The project id is bound to the login, so a rejected token
            // means the one we remembered may not be ours any more.
            if (failure.status === Status.EXPIRED)
                this._projectId = null;
            return failure;
        }
    },

    // The project the quota hangs off. It does not change, so it is asked for
    // once and kept -- halving the requests every poll after the first.
    async _project(http, headers, cancellable) {
        if (this._projectId)
            return this._projectId;

        const body = await http.postJson(LOAD_URL, headers, {metadata: {ideType: 'ANTIGRAVITY'}}, cancellable);
        this._projectId = typeof body?.cloudaicompanionProject === 'string'
            ? body.cloudaicompanionProject
            : null;
        this._plan = tierLabel(body?.currentTier);
        return this._projectId;
    },

    _parse(body) {
        const groups = Array.isArray(body?.groups) ? body.groups : [];
        const limits = [];

        for (const group of groups) {
            const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
            for (const bucket of buckets) {
                const limit = limitFromBucket(group, bucket);
                if (limit)
                    limits.push(limit);
            }
        }

        if (!limits.length)
            throw new Error('no quota buckets in the response');

        // Shortest window first, so the one about to bite reads first.
        limits.sort((a, b) => windowRank(a.id) - windowRank(b.id));
        return this._reading({status: Status.OK, plan: this._plan, limits});
    },

    _reading({status, plan = null, limits = [], message = null}) {
        return reading(this, {
            status,
            plan: plan ?? this._plan ?? null,
            limits,
            message,
        });
    },
};

// ---- the response -----------------------------------------------------------

// *** The response reports what is LEFT, and this extension shows what is USED.
// *** Every other provider reports the figure the other way round, so getting
// this backwards would put "100%" on the button at the moment a limit was
// untouched. It is the single most dangerous line in this file.
function limitFromBucket(group, bucket) {
    // Strictly a real number: a null here would invert to 100% used and
    // report an untouched limit as exhausted.
    const remaining = numberOrNull(bucket?.remainingFraction);
    if (remaining === null)
        return null;

    const percent = (1 - Math.max(0, Math.min(1, remaining))) * 100;
    return new Limit({
        id: typeof bucket?.bucketId === 'string' ? bucket.bucketId : 'quota',
        // The bucket's own displayName is "Weekly Limit Remaining", which would
        // be an outright lie over a figure that counts what has been used. The
        // label is built from the window and the model family instead.
        label: bucketLabel(group, bucket),
        percent,
        resetsAt: parseTimestamp(bucket?.resetTime),
    });
}

function bucketLabel(group, bucket) {
    const window = windowLabel(bucket?.window);
    const family = typeof group?.displayName === 'string' ? group.displayName : null;
    return family ? `${window} · ${family}` : window;
}

function windowLabel(window) {
    switch (window) {
    case '5h':
        return 'Current session';
    case 'weekly':
        return 'This week';
    case 'daily':
        return 'Today';
    default:
        return 'Current limit';
    }
}

// Sorting is by the bucket id, which carries the window: the 5-hour buckets
// come before the weekly ones.
function windowRank(id) {
    if (typeof id !== 'string')
        return 3;
    if (id.includes('5h'))
        return 0;
    if (id.includes('daily'))
        return 1;
    if (id.includes('weekly'))
        return 2;
    return 3;
}

// "free-tier" -> "Free tier". The tier's display name is just "Antigravity",
// which beside the provider's own name would say nothing.
function tierLabel(tier) {
    const id = tier?.id;
    if (typeof id !== 'string' || !id)
        return null;
    return id.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ---- the stored login -------------------------------------------------------

// Keyring first, file second. Read fresh every poll and never kept.
async function readCredentials(cancellable) {
    const fromKeyring = await lookupKeyring(cancellable);
    if (fromKeyring)
        return fromKeyring;
    return readTokenFile();
}

function lookupKeyring(cancellable) {
    return new Promise(resolve => {
        Secret.password_lookup(KEYRING_SCHEMA, KEYRING_ATTRIBUTES, cancellable, (_o, result) => {
            let secret = null;
            try {
                secret = Secret.password_lookup_finish(result);
            } catch (e) {
                // A locked keyring, or no secret service at all. Neither is a
                // fault to shout about -- the file is tried next.
                Log.debug(`Antigravity keyring lookup failed: ${e.message}`);
            }
            resolve(secret ? parseToken(secret) : null);
        });
    });
}

function readTokenFile() {
    const text = readText(AntigravityProvider.credentialsFile(), 'Antigravity token file');
    return text === null ? null : parseToken(text);
}

function parseToken(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    const accessToken = parsed?.token?.access_token;
    if (typeof accessToken !== 'string' || !accessToken)
        return null;

    // The expiry is RFC3339 with nanoseconds, which GLib parses happily.
    const expiry = GLib.DateTime.new_from_iso8601(parsed.token.expiry ?? '', null);
    return {
        accessToken,
        // No expiry means letting the request decide rather than assuming.
        expired: expiry ? expiry.to_unix() * 1000 <= Date.now() : false,
        plan: null,
    };
}
