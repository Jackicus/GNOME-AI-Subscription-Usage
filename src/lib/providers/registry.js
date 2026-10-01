// Which providers exist, and how to add one.
//
// A provider is an object with:
//
//   id           the string the per-provider settings path and the button's
//                panel role are built from
//   displayName  what the pop-up calls it
//   cli          the command whose login it borrows, for the "run it once"
//                message and for detect()
//   icon         optional: the name of a symbolic icon shipped in src/icons/,
//                without the extension, so 'claude-symbolic' is the file
//                icons/claude-symbolic.svg. A plain string and nothing else --
//                a Gio.File here would drag Gio's file machinery, and anything
//                St-shaped would drag the shell, into the prefs process, which
//                cannot load either. Absent, or naming a file that is not
//                there, and the button falls back to the extension's own gauge.
//   capabilities which of the per-provider switches it can honour -- perModel,
//                breakdown, credits -- so that the preferences offer only those
//   detect()     whether that command is on PATH at all; a provider that is not
//                installed is left out of the pop-up entirely rather than
//                shown as broken
//   credentialsFile()
//                the Gio.File of the stored login, which the app watches so a
//                refresh by the tool is read at once. (Antigravity's is only
//                the fallback: its login lives in the secret service)
//   read(http, cancellable) -> Promise<Reading>
//                the figures, or a Reading whose status says why not. Each call
//                reads the login afresh: a token is never held between polls
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
//   4. Add it here. Nothing else needs touching.
//
// Both steps 1 and 2 are undocumented for every provider so far, so a provider
// module is expected to be defensive and to go quiet -- Status.UNAVAILABLE --
// rather than throw when what it finds is not the shape it knew.

import {AntigravityProvider} from './antigravity.js';
import {ClaudeProvider} from './claude.js';
import {CodexProvider} from './codex.js';

const PROVIDERS = new Map([
    [ClaudeProvider.id, ClaudeProvider],
    [CodexProvider.id, CodexProvider],
    [AntigravityProvider.id, AntigravityProvider],
]);

export function allProviders() {
    return [...PROVIDERS.values()];
}
