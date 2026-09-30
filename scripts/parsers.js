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
import {ClaudeProvider, planLabel, readAccountTier} from '../src/lib/providers/claude.js';
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

// Where the plan name comes from, and in what order. The tier in the
// credentials file is stamped there at sign-in and never rewritten, so on an
// account that has since changed plan it is simply wrong -- a Max 20x account
// read from it says "Max 5x" (issue #12). ~/.claude.json is the copy Claude
// Code refreshes when it starts, so it is asked first; every way that file can
// fail has to fall through to the old source rather than take the pop-up down.
print('\n\x1b[1mClaude\x1b[0m — the plan name, and which file it comes from');
{
    const dir = GLib.dir_make_tmp('ai-usage-plan-XXXXXX');
    const written = [];
    // The account file as it would be on disk, read the way the extension
    // reads the real one -- so what is pinned here is the actual file handling
    // rather than a re-statement of it. A null text means no file at all.
    const accountTier = text => {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([dir, `claude-${written.length}.json`]));
        if (text !== null) {
            file.replace_contents(new TextEncoder().encode(text), null, false,
                Gio.FileCreateFlags.NONE, null);
            written.push(file);
        }
        return readAccountTier(file);
    };

    // The real shape: the organisation's tier, the admin's own one null.
    const live = accountTier(JSON.stringify({
        numStartups: 42,
        oauthAccount: {
            emailAddress: 'someone@example.com',
            organizationRateLimitTier: 'default_claude_max_20x',
            userRateLimitTier: null,
            organizationRole: 'admin',
        },
    }));
    const stale = {rateLimitTier: 'default_claude_max_5x', subscriptionType: 'max'};

    check('the account file is read', live, 'default_claude_max_20x');
    check('max_20x humanises', planLabel({accountTier: live}), 'Max 20x');
    check('it beats the stale credentials tier', planLabel({...stale, accountTier: live}), 'Max 20x');
    check('which on its own would have said', planLabel(stale), 'Max 5x');

    // A personal account carries no organisation tier, so its own is taken.
    check('userRateLimitTier when there is no org tier',
        accountTier(JSON.stringify({oauthAccount: {
            organizationRateLimitTier: null, userRateLimitTier: 'default_claude_pro',
        }})), 'default_claude_pro');

    // Each of these is an ordinary state and not a fault: no file until Claude
    // Code has run, a half-written one while it rewrites, and no oauthAccount
    // at all until it has been signed into once.
    check('an absent file yields no tier', accountTier(null), null);
    check('an unparseable file yields no tier', accountTier('{"oauthAccount": {"organi'), null);
    check('a file with no oauthAccount yields none', accountTier('{"numStartups": 42}'), null);
    check('an empty tier is not a tier', accountTier('{"oauthAccount": {"organizationRateLimitTier": ""}}'), null);
    check('a non-string tier is not a tier', accountTier('{"oauthAccount": {"userRateLimitTier": 7}}'), null);

    // ...and every one of them falls through to what there was before.
    for (const [what, text] of [['absent', null], ['unparseable', '{"oauthAcc'],
        ['without oauthAccount', '{}']]) {
        check(`${what} falls back to the credentials`,
            planLabel({...stale, accountTier: accountTier(text)}), 'Max 5x');
    }
    check('with no tier anywhere, the subscription name',
        planLabel({subscriptionType: 'max', accountTier: accountTier(null)}), 'Max');
    check('nothing known at all means no plan shown', planLabel({}), null);

    // And the whole way through, on a real response.
    const reading = parse(ClaudeProvider, fixture('claude-usage.json'),
        {...stale, accountTier: live});
    check('the reading carries the live plan', reading.plan, 'Max 20x');

    for (const file of written)
        file.delete(null);
    Gio.File.new_for_path(dir).delete(null);
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

// The shapes that caused real bugs. Number(null) is 0, so a null percentage
// used to become a confident 0% row -- and for Antigravity, which reports what
// is LEFT, a null read as a limit fully spent. Each of these is a regression
// test for a bug that was actually shipped into a commit.
print('\n\x1b[1mHostile shapes\x1b[0m — a wrong number is worse than no number');
{
    const claude = parse(ClaudeProvider, {
        limits: [
            {kind: 'session', percent: null, resets_at: null},
            {kind: 'weekly_all', percent: 42, resets_at: null},
            {kind: 'weekly_scoped', percent: 10, scope: {surface: {display_name: 'Cowork'}}},
        ],
    }, {});
    check('claude drops a null percent', claude.limits.length, 2);
    check('claude keeps the real one', formatPercent(claude.limits[0].percent), '42%');
    check('a surface-scoped row is named', claude.limits[1].label, 'This week · Cowork');
    check('and counts as scoped, so it can be hidden', claude.limits[1].scoped, true);

    const credits = parse(ClaudeProvider, {
        limits: [{kind: 'session', percent: 5}],
        extra_usage: {is_enabled: true, utilization: null},
        spend: {percent: 30, severity: 'warning', used: {amount_minor: 1234, currency: 'USD', exponent: 2}},
    }, {});
    // The figure and the severity must come from the same object. Before, the
    // percent fell back to 0 while the severity came from spend, giving an
    // empty bar painted as a warning.
    check('credits take the figure beside their severity', formatPercent(credits.credits.percent), '30%');
    check('and the service severity is still honoured', credits.credits.severity, 'warning');

    const noFigure = parse(ClaudeProvider, {
        limits: [{kind: 'session', percent: 5}],
        extra_usage: {is_enabled: true, utilization: null},
        spend: {used: {amount_minor: 0, currency: 'USD', exponent: 2}},
    }, {});
    check('no credits figure means no credits row', noFigure.credits, null);

    const anti = AntigravityProvider._parse({
        groups: [{displayName: 'Gemini Models', buckets: [
            {bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: null},
            {bucketId: 'gemini-5h', window: '5h', remainingFraction: 0},
        ]}],
    }, THRESHOLDS);
    check('antigravity drops a null fraction', anti.limits.length, 1);
    check('rather than reading it as fully spent', anti.limits.every(l => l.percent !== 100 || l.id === 'gemini-5h'), true);

    const codex = parse(CodexProvider, {
        plan_type: 'plus',
        rate_limit: {
            primary_window: {used_percent: null, limit_window_seconds: 18000, reset_at: 2000000000},
            secondary_window: {used_percent: 20, limit_window_seconds: 604800, reset_after_seconds: 600},
        },
        credits: {has_credits: false, balance: '0'},
        additional_rate_limits: [],
    }, {});
    check('codex drops a null percent', codex.limits.length, 1);
    // A reset time derived from reset_after_seconds moves on every poll, and
    // notifications are remembered by that timestamp -- so the limit would
    // announce itself again every single poll.
    check('no absolute reset means no reset shown', codex.limits[0].resetsAt, null);
    check('a recognised window takes the shared id', codex.limits[0].id, 'weekly_all');
    check('no credits means no credits row', codex.credits, null);

    const ids = parse(CodexProvider, {
        rate_limit: {primary_window: {used_percent: 1, limit_window_seconds: 18000, reset_at: 2000000000}},
        additional_rate_limits: [{rate_limit: {primary_window: {used_percent: 2, limit_window_seconds: 18000, reset_at: 2000000000}}}],
    }, {});
    check('session window takes the shared id', ids.limits[0].id, 'session');
    check('an unnamed model bucket keeps a stable id', ids.limits[1].id, 'model:bucket0');
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
