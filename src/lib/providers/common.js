import GLib from 'gi://GLib';

import {Reading, Status} from '../usage.js';
import * as Log from '../log.js';

export function detect(cli) {
    return GLib.find_program_in_path(cli) !== null;
}

export function reading(provider, fields) {
    return new Reading({
        providerId: provider.id,
        displayName: provider.displayName,
        ...fields,
    });
}

// The file's text, or null. A missing login file is ordinary, so only a debug line.
export function readText(file, what) {
    try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        Log.debug(`No ${what} to read: ${e.message}`);
        return null;
    }
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

export function failureReading(provider, e, plan = null) {
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
