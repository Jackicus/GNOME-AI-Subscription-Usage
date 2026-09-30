// Runs each provider's parser over a saved response and checks what comes out.
// `./scripts/dev.sh parsers`, and `make check`.
//
// This is the only test that can run without a GNOME Shell, and for providers
// whose command-line tool is not installed here it is the ONLY check there is:
// the Codex parser has never seen a live response, so this fixture -- taken
// from the shapes in openai/codex's own tests -- is what stands behind it.
//
// The endpoints are undocumented and their shapes move, so the point is less
// "does this pass today" than "say so loudly the day a response changes".
// Nothing here ships.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {applyOptions} from '../src/lib/settings.js';
import {AntigravityProvider} from '../src/lib/providers/antigravity.js';
import {ClaudeProvider} from '../src/lib/providers/claude.js';
import {CodexProvider} from '../src/lib/providers/codex.js';
import {Status, formatPercent} from '../src/lib/usage.js';

const THRESHOLDS = {warn: 80, critical: 95};

const RED = '\x1b[1;31m';
const GREEN = '\x1b[1;32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let failures = 0;

function check(what, got, want) {
    const ok = String(got) === String(want);
    if (!ok)
        failures++;
    const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    const detail = ok ? `${DIM}${got}${OFF}` : `${RED}got ${got}, wanted ${want}${OFF}`;
    print(`  ${mark} ${what.padEnd(42)} ${detail}`);
}

function fixture(name) {
    const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const path = GLib.build_filenamev([dir, '..', 'tests', 'fixtures', name]);
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

// The parsers take the credentials only for the plan label, so a stub is enough
// -- no token is needed to parse a response that has already arrived.
function parse(provider, body, auth) {
    return provider._parse(body, auth, THRESHOLDS);
}

print('\x1b[1mClaude\x1b[0m — tests/fixtures/claude-usage.json');
{
    const reading = parse(ClaudeProvider, fixture('claude-usage.json'),
        {rateLimitTier: 'default_claude_max_5x'});

    check('status', reading.status, Status.OK);
    check('plan label from the rate limit tier', reading.plan, 'Max 5x');
    check('limits found', reading.limits.length, 3);
    check('ordered session first', reading.limits[0].id, 'session');
    check('session percent', formatPercent(reading.limits[0].percent), '50%');
    check('severity from the response (warning)', reading.limits[1].severity, 'warning');
    check('severity from the response (critical)', reading.limits[2].severity, 'critical');
    check('per-model row is labelled', reading.limits[2].label, 'This week · Fable');
    check('per-model row is marked scoped', reading.limits[2].scoped, true);
    check('whole-account row is not scoped', reading.limits[1].scoped, false);
    check('active limit marked', reading.limits[2].active, true);
    check('reset time parsed', reading.limits[0].resetsAt?.format_iso8601(), '2026-09-30T18:10:00Z');
    check('breakdown rows kept', reading.breakdown.length, 1);
    check('breakdown label', reading.breakdown[0].label, 'Claude Code');
    check('credits absent when not enabled', reading.credits, null);
    check('worst limit is the highest', formatPercent(reading.worst.percent), '97%');
}

print('\n\x1b[1mCodex\x1b[0m — tests/fixtures/codex-usage.json  \x1b[2m(shape only; never seen live)\x1b[0m');
{
    const reading = parse(CodexProvider, fixture('codex-usage.json'), {plan: null});

    check('status', reading.status, Status.OK);
    check('plan label from plan_type', reading.plan, 'Plus');
    check('limits found', reading.limits.length, 3);
    check('5h window named from its length', reading.limits[0].label, 'Current session');
    check('7d window named from its length', reading.limits[1].label, 'This week');
    check('primary percent', formatPercent(reading.limits[0].percent), '50%');
    check('severity derived from percent', reading.limits[1].severity, 'warning');
    check('per-model row labelled by model', reading.limits[2].label, 'Current session · gpt-5-codex');
    check('per-model row is marked scoped', reading.limits[2].scoped, true);
    check('whole-account row is not scoped', reading.limits[0].scoped, false);
    check('epoch reset converted', reading.limits[0].resetsAt?.format_iso8601(), '2033-05-18T03:33:20Z');
    check('null secondary window skipped', reading.limits.filter(l => l.scoped).length, 1);
    check('credits balance read', reading.credits?.label, 'Credits · 12 left');
    check('no breakdown for this provider', reading.breakdown.length, 0);
}

print('\n\x1b[1mAntigravity\x1b[0m — tests/fixtures/antigravity-quota.json  \x1b[2m(real, plus a synthetic 5h bucket)\x1b[0m');
{
    AntigravityProvider._plan = 'Free tier';
    const reading = AntigravityProvider._parse(fixture('antigravity-quota.json'), THRESHOLDS);

    check('status', reading.status, Status.OK);
    check('buckets found', reading.limits.length, 3);

    // The response says what is LEFT and the extension shows what is USED.
    // Getting this backwards would read 100% on an untouched limit.
    // Sorted: the 5-hour bucket, then the weekly ones in the order the
    // response listed them (the sort is stable, and both rank the same).
    check('remainingFraction 0.35 means 65% used', formatPercent(reading.limits[0].percent), '65%');
    check('remainingFraction 0 means fully used', formatPercent(reading.limits[1].percent), '100%');
    check('remainingFraction 1 means untouched', formatPercent(reading.limits[2].percent), '0%');

    check('shortest window sorts first', reading.limits[0].id, 'gemini-5h');
    check('5h window labelled', reading.limits[0].label, 'Current session · Gemini Models');
    check('weekly window labelled', reading.limits[1].label, 'This week · Gemini Models');
    check('the other family keeps its own row', reading.limits[2].label, 'This week · Claude and GPT models');
    // The bucket's own displayName is "Weekly Limit Remaining", which over a
    // used-figure would be a plain lie. It must not reach the label.
    check('the response label is NOT reused', reading.limits[1].label.includes('Remaining'), false);
    check('an exhausted bucket is critical', reading.limits[1].severity, 'critical');
    check('an untouched bucket is normal', reading.limits[2].severity, 'normal');
    check('reset time parsed', reading.limits[1].resetsAt?.format_iso8601(), '2026-10-05T20:12:05Z');
    check('nothing is marked per-model', reading.limits.filter(l => l.scoped).length, 0);
}

// The display switches must never destroy what they hide: turning one back on
// has to restore the row at once, without waiting for the next poll.
print('\n\x1b[1mDisplay switches\x1b[0m — hiding a row must not throw it away');
{
    const full = parse(ClaudeProvider, fixture('claude-usage.json'),
        {rateLimitTier: 'default_claude_max_5x'});
    const everything = {showInPanel: true, showPerModel: true, showBreakdown: true, showCredits: true};
    const hidden = applyOptions(full, {...everything, showPerModel: false, showBreakdown: false});

    check('per-model rows hidden in the view', hidden.limits.length, 2);
    check('breakdown hidden in the view', hidden.breakdown.length, 0);
    check('the reading itself is untouched', full.limits.length, 3);
    check('its breakdown is untouched', full.breakdown.length, 1);

    const restored = applyOptions(full, everything);
    check('turning it back on restores the rows', restored.limits.length, 3);
    check('and the breakdown', restored.breakdown.length, 1);
    check('the view keeps its getters', restored.ok, true);
    check('and its computed properties', formatPercent(restored.worst.percent), '97%');

    const offPanel = applyOptions(full, {...everything, showInPanel: false});
    check('panel eligibility follows the switch', offPanel.panelEligible, false);
    check('without changing the reading', full.panelEligible, true);
}

// An unreadable response must degrade, never throw: a provider that throws
// takes the whole pop-up down with it.
print('\n\x1b[1mBoth\x1b[0m — a response in a shape they do not know');
for (const provider of [ClaudeProvider, CodexProvider, AntigravityProvider]) {
    let threw = null;
    try {
        // Antigravity's parser takes no credentials; the others ignore the
        // second argument when the body is unusable.
        if (provider === AntigravityProvider)
            provider._parse({nonsense: true}, THRESHOLDS);
        else
            parse(provider, {nonsense: true}, {});
    } catch (e) {
        threw = e;
    }
    check(`${provider.id} rejects it rather than inventing figures`, threw !== null, true);
}

print('');
if (failures) {
    print(`${RED}${failures} check(s) failed.${OFF}`);
    throw new Error(`${failures} parser check(s) failed`);
}
print(`${GREEN}All parser checks passed.${OFF}`);
