// What the providers would otherwise each say for themselves.
//
// Small on purpose: the things that were word-for-word the same in all of them,
// and nothing that merely resembles each other. It imports only GLib and the
// model, so the preferences process can load the providers that use it --
// `make imports` holds that.

import GLib from 'gi://GLib';

import {Reading, Status} from '../usage.js';
import * as Log from '../log.js';

// Whether the provider's command-line tool is installed. A provider whose tool
// is not on PATH is left out entirely rather than shown as broken.
export function detect(cli) {
    return GLib.find_program_in_path(cli) !== null;
}

// A Reading for this provider, so that none of them spells out whose it is.
export function reading(provider, fields) {
    return new Reading({
        providerId: provider.id,
        displayName: provider.displayName,
        ...fields,
    });
}

// The file's text, or null when it cannot be had. Not having a login file is
// the ordinary case -- there is none until the tool has been signed into once --
// so it is a debug line rather than a warning; `what` names the file in it.
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

// An ISO 8601 string as a GLib.DateTime, rounded to the nearest whole minute,
// or null for anything else. The services jitter a reset by fractions of a
// second from one call to the next, and now and then across a minute boundary
// (13:59:59.748 and then 14:00:00.116), so the same reset would read as
// "Tue 14:59" on one row and "Tue 15:00" on the next, and would not be the
// same window to _maybeNotify(). Rounding here, once, for every provider, is
// what makes a reset time the same thing every time it is read. Halves round
// up: 14:00:30 is 14:01.
export function parseTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    const at = GLib.DateTime.new_from_iso8601(value, null);
    if (!at)
        return null;
    const seconds = at.to_unix() + at.get_microsecond() / 1e6;
    return GLib.DateTime.new_from_unix_utc(Math.round(seconds / 60) * 60);
}

// The Reading for a request that failed.
export function failureReading(provider, e, plan = null) {
    // Read duck-typed rather than against HttpError, so that a provider
    // needs no import from the HTTP layer -- which is what keeps Soup out
    // of the import graph and lets prefs.js load this registry.
    const status = Number.isFinite(e?.status) ? e.status : 0;
    // 401 and 403 are the stored token being stale or withdrawn, which is
    // the one failure the user can do something about.
    const expired = status === 401 || status === 403;
    return reading(provider, {
        status: expired ? Status.EXPIRED : Status.UNAVAILABLE,
        plan,
        message: expired ? null : e.message,
    });
}

// The Reading for a response that arrived but was not the shape the parser
// knew. Say the figures are unavailable rather than showing a wrong number.
export function unknownShapeReading(provider, e, plan = null) {
    Log.warn(`Could not read ${provider.displayName}'s usage response: ${e.message}`);
    return reading(provider, {
        status: Status.UNAVAILABLE,
        plan,
        message: 'The service answered in a shape this version does not know.',
    });
}
