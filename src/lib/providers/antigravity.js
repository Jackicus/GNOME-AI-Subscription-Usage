// agy keeps its login in the keyring; the token file is only written without a
// D-Bus session and is stale on a desktop, so it is the fallback. Not
// `agy -p /usage`: that takes about eleven seconds and starts the MCP servers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';

import {Limit, Status, numberOrNull, stringOrNull} from '../usage.js';
import * as Log from '../log.js';
import {failureReading, humanise, parseTimestamp, readJson, reading} from './common.js';

const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

// The service answers 403 to a user agent not starting "antigravity".
const USER_AGENT = 'antigravity/cli (gnome-shell-extension-ai-usage)';

const KEYRING_ATTRIBUTES = {service: 'gemini', username: 'antigravity'};

export const AntigravityProvider = {
    id: 'antigravity',
    displayName: 'Antigravity',
    cli: 'agy',
    cliName: 'the Antigravity CLI (agy)',
    icon: 'antigravity-symbolic',

    capabilities: {
        // Its buckets per model family are the account's only limits.
        perModel: false,
        breakdown: false,
        credits: false,
    },

    // The fallback file only: the keyring cannot be watched.
    credentialsFile() {
        return Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_home_dir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token']));
    },

    async read(http, cancellable = null) {
        let auth;
        try {
            auth = await readCredentials(cancellable);
        } catch (e) {
            Log.debug(`Could not read Antigravity's login: ${e.message}`);
            auth = null;
        }

        if (!auth)
            return reading(this, {status: Status.SIGNED_OUT, plan: this._plan});
        if (auth.expired)
            return reading(this, {status: Status.EXPIRED, plan: this._plan});

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
            const failure = failureReading(this, e, this._plan);
            // The project belongs to the login, so a rejected login forgets it.
            if (failure.status === Status.EXPIRED)
                this._projectId = null;
            return failure;
        }
    },

    // Asked for once and kept, which halves the requests per poll.
    async _project(http, headers, cancellable) {
        if (this._projectId)
            return this._projectId;

        const body = await http.postJson(LOAD_URL, headers, {metadata: {ideType: 'ANTIGRAVITY'}}, cancellable);
        this._projectId = stringOrNull(body?.cloudaicompanionProject);
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

        limits.sort((a, b) => windowRank(a.id) - windowRank(b.id));
        return reading(this, {status: Status.OK, plan: this._plan, limits});
    },
};

// The API reports the fraction LEFT; this shows the share used.
function limitFromBucket(group, bucket) {
    const remaining = numberOrNull(bucket?.remainingFraction);
    if (remaining === null)
        return null;

    const percent = (1 - Math.max(0, Math.min(1, remaining))) * 100;
    return new Limit({
        id: typeof bucket?.bucketId === 'string' ? bucket.bucketId : 'quota',
        // Not the bucket's displayName, "Weekly Limit Remaining", over a used figure.
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

// Shortest window first, by the bucket id, which carries the window.
function windowRank(id) {
    if (id.includes('5h'))
        return 0;
    if (id.includes('daily'))
        return 1;
    if (id.includes('weekly'))
        return 2;
    return 3;
}

// "free-tier" -> "Free tier"; the tier's displayName is only "Antigravity".
function tierLabel(tier) {
    const id = stringOrNull(tier?.id);
    return id && humanise(id);
}

// Read fresh every poll and never kept.
async function readCredentials(cancellable) {
    return await lookupKeyring(cancellable) ??
        tokenFrom(readJson(AntigravityProvider.credentialsFile(), 'Antigravity token file'));
}

function lookupKeyring(cancellable) {
    return new Promise(resolve => {
        // go-keyring's item: the generic schema, matched on its attributes only.
        const schema = new Secret.Schema('org.freedesktop.Secret.Generic', Secret.SchemaFlags.DONT_MATCH_NAME, {
            service: Secret.SchemaAttributeType.STRING,
            username: Secret.SchemaAttributeType.STRING,
        });
        Secret.password_lookup(schema, KEYRING_ATTRIBUTES, cancellable, (_o, result) => {
            let secret = null;
            try {
                secret = JSON.parse(Secret.password_lookup_finish(result));
            } catch (e) {
                // A locked keyring or no secret service: the file is tried next.
                Log.debug(`Antigravity keyring lookup failed: ${e.message}`);
            }
            resolve(tokenFrom(secret));
        });
    });
}

function tokenFrom(parsed) {
    const accessToken = stringOrNull(parsed?.token?.access_token);
    if (!accessToken)
        return null;

    const expiry = GLib.DateTime.new_from_iso8601(parsed.token.expiry ?? '', null);
    return {
        accessToken,
        // No expiry: the request decides.
        expired: expiry ? expiry.to_unix() * 1000 <= Date.now() : false,
    };
}
