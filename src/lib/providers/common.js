import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Reading, Status} from '../usage.js';
import * as Log from '../log.js';

export function reading(provider, fields) {
    return new Reading({
        providerId: provider.id,
        displayName: provider.displayName,
        ...fields,
    });
}

// The file's JSON, or null when it is missing or half-written: both are
// ordinary for a login file, so only a debug line.
export function readJson(file, what) {
    try {
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        Log.debug(`No ${what} to read: ${e.message}`);
        return null;
    }
}

// "free-tier" -> "Free tier".
export function humanise(id) {
    return id.replace(/[_-]+/g, ' ').trim().replace(/^\w/, c => c.toUpperCase());
}

// Rounded to the minute: the services jitter a reset across minute boundaries,
// and a notification is keyed by it.
export function parseTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    const at = GLib.DateTime.new_from_iso8601(value, null);
    if (!at)
        return null;
    const seconds = at.to_unix() + at.get_microsecond() / 1e6;
    return GLib.DateTime.new_from_unix_utc(Math.round(seconds / 60) * 60);
}

// A cancelled request is thrown on: the app drops that round.
export function failureReading(provider, e, plan = null) {
    if (e instanceof Gio.IOErrorEnum)
        throw e;
    // Duck-typed, not HttpError: importing http.js would put Soup in prefs' graph.
    const status = Number.isFinite(e.status) ? e.status : 0;
    const expired = status === 401 || status === 403;
    return reading(provider, {
        status: expired ? Status.EXPIRED : Status.UNAVAILABLE,
        plan,
        message: expired ? null : e.message,
    });
}

export function unknownShapeReading(provider, e, plan = null) {
    Log.warn(`Could not read ${provider.displayName}'s usage response: ${e.message}`);
    return reading(provider, {
        status: Status.UNAVAILABLE,
        plan,
        message: 'The service answered in a shape this version does not know.',
    });
}
