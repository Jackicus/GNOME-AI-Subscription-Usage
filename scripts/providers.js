// What the extension would see, printed in a terminal: for every provider, is
// its command-line tool installed, is there a login stored, and what figures
// come back. `./scripts/dev.sh providers`.
//
// It runs the extension's own provider modules -- src/lib/providers/ -- rather
// than a copy of their logic, so agreeing with the button is not a coincidence.
// Nothing in here ships.

import GLib from 'gi://GLib';

import {Http} from '../src/lib/http.js';
import {allProviders} from '../src/lib/providers/registry.js';
import {Status, formatPercent, formatReset} from '../src/lib/usage.js';
import * as Log from '../src/lib/log.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const EXPLANATION = {
    [Status.SIGNED_OUT]: 'no stored login found -- sign in with its command-line tool',
    [Status.EXPIRED]: 'the stored login was rejected -- run its command-line tool once to refresh it',
    [Status.UNSUPPORTED]: 'signed in, but this login has no subscription limits',
    [Status.UNAVAILABLE]: 'the figures could not be read',
};

function bar(percent, width = 24) {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
    return `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
}

async function report(http, provider) {
    print(`${BOLD}${provider.displayName}${OFF} ${DIM}(${provider.id})${OFF}`);

    if (!provider.detect()) {
        print(`  '${provider.cli}' is not on PATH -- the extension leaves this provider out.\n`);
        return;
    }
    print(`  cli:      ${GLib.find_program_in_path(provider.cli)}`);

    const reading = await provider.read(http);
    print(`  plan:     ${reading.plan ?? '(unknown)'}`);

    if (!reading.ok) {
        const why = EXPLANATION[reading.status] ?? reading.status;
        print(`  status:   ${reading.status} -- ${why}`);
        if (reading.message)
            print(`            ${reading.message}`);
        print('');
        return;
    }

    print('  limits:');
    for (const limit of reading.limits) {
        const reset = formatReset(limit.resetsAt);
        const marks = [limit.severity, limit.active ? 'in force' : null].filter(m => m && m !== 'normal');
        print(`    ${limit.label.padEnd(26)} [${bar(limit.percent)}] ${formatPercent(limit.percent).padStart(4)}`
            + `  ${DIM}${[reset, ...marks].filter(p => p).join(', ')}${OFF}`);
    }

    if (reading.breakdown.length) {
        const parts = reading.breakdown.map(row => `${row.label} ${formatPercent(row.percent)}`);
        print(`  week went to: ${parts.join(', ')}`);
    }
    if (reading.credits)
        print(`  credits:  ${reading.credits.label} (${formatPercent(reading.credits.percent)})`);
    print('');
}

// gjs has no top-level await, so the work runs inside a main loop that the last
// provider stops.
const loop = new GLib.MainLoop(null, false);
const http = new Http('gnome-shell-extension-ai-usage/dev');
let failed = false;

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    (async () => {
        for (const provider of allProviders()) {
            try {
                // Providers are independent and there are a handful at most;
                // one at a time keeps the output in a readable order.
                // eslint-disable-next-line no-await-in-loop
                await report(http, provider);
            } catch (e) {
                failed = true;
                Log.error(`${provider.id} threw, which a provider is not allowed to do`, e);
            }
        }
        http.destroy();
        loop.quit();
    })();
    return GLib.SOURCE_REMOVE;
});

loop.run();
if (failed)
    throw new Error('a provider threw; see above');
