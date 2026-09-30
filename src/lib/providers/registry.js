// Which providers exist, and how to add one.
//
// A provider is an object with:
//
//   id           the string the `providers` setting uses
//   displayName  what the pop-up calls it
//   cli          the command whose login it borrows, for the "install it first"
//                message and for detect()
//   detect()     whether that command is on PATH at all; a provider that is not
//                installed is left out of the pop-up entirely rather than
//                shown as broken
//   read(http, cancellable) -> Reading
//                the figures, or a Reading whose status says why not
//
// The contract read() must keep: never throw (return a Reading with a status
// instead), never write to the provider's files, and never perform a login.
// Signing in belongs to the provider's own command-line tool -- this extension
// only ever reads the login that tool has already stored, so that there is one
// place a user signs in and one place a token can be rotated.
//
// Adding a provider, the way the Claude one was worked out:
//
//   1. Find the request its command-line tool makes for its own usage command.
//      `strings` over the installed binary, grepped for "usage" or "limit",
//      turned up /api/oauth/usage for Claude.
//   2. Find where that tool stores the login it made at sign-in.
//   3. Write lib/providers/<id>.js mapping the response onto Limit objects.
//   4. Add it here, and to the `providers` key's default if it should be on.
//
// Both steps 1 and 2 are undocumented for every provider so far, so a provider
// module is expected to be defensive and to go quiet -- Status.UNAVAILABLE --
// rather than throw when what it finds is not the shape it knew.

import {ClaudeProvider} from './claude.js';
import {CodexProvider} from './codex.js';

const PROVIDERS = new Map([
    [ClaudeProvider.id, ClaudeProvider],
    [CodexProvider.id, CodexProvider],
]);

export function allProviders() {
    return [...PROVIDERS.values()];
}

// The providers named in settings, in that order, skipping names we do not know
// (a setting written by a newer version, or a typo).
export function resolveProviders(ids) {
    return ids.map(id => PROVIDERS.get(id)).filter(p => p);
}
