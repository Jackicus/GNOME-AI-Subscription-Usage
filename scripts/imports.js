// Checks that the preferences can still load what they load.
// `./scripts/dev.sh imports`, and `make check`.
//
// prefs.js runs in its own process, without the shell. It cannot load St, or
// Clutter, or anything under resource:///org/gnome/shell/ -- and it reaches the
// provider registry and settings.js, so neither of those, nor anything they
// import, may drag one in. That is why claude.js reads `e.status` duck-typed
// instead of importing HttpError: one import of http.js would put Soup in the
// graph and the preferences would stop opening.
//
// It is an easy rule to break by accident and an invisible one to break: the
// shell side keeps working, and only the preferences fail, in a process nobody
// is watching. So the graph is walked from prefs.js and every module in it is
// held to the rule, and then the two modules the preferences share with the
// shell are actually loaded, to prove it rather than infer it.
//
// Nothing here ships.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const RED = '\x1b[1;31m';
const GREEN = '\x1b[1;32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

// What a module in the preferences' graph may not import. The shell's own
// resource path is lowercase `shell`; the preferences' own entry point lives
// under `Shell/Extensions`, which is a different thing and is allowed.
const FORBIDDEN = [
    'gi://St', 'gi://Clutter', 'gi://Meta', 'gi://Shell', 'gi://Soup',
    'resource:///org/gnome/shell/',
];

const SRC = GLib.canonicalize_filename(GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'src']), null);

let failures = 0;

function check(what, got, want) {
    const ok = String(got) === String(want);
    if (!ok)
        failures++;
    const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    const detail = ok ? `${DIM}${got}${OFF}` : `${RED}got ${got}, wanted ${want}${OFF}`;
    print(`  ${mark} ${what.padEnd(42)} ${detail}`);
}

function read(path) {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(bytes);
}

// Static `import ... from '...'`, bare `import '...'`, and dynamic `import('...')`.
// A regex rather than a parser: these files are plain ES modules written in one
// house style, and a dependency on acorn for this would be its own cost.
function importsOf(source) {
    const specifiers = [];
    const patterns = [
        /\bfrom\s+['"]([^'"]+)['"]/g,
        /\bimport\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern))
            specifiers.push(match[1]);
    }
    return specifiers;
}

// Every module reachable from `entry` by relative import, as path -> [specifier].
function graphFrom(entry) {
    const seen = new Map();
    const queue = [entry];

    while (queue.length) {
        const path = queue.shift();
        if (seen.has(path))
            continue;

        const specifiers = importsOf(read(path));
        seen.set(path, specifiers);

        for (const specifier of specifiers) {
            if (!specifier.startsWith('.'))
                continue;   // gi:// and resource:// are leaves, not files to walk
            queue.push(GLib.canonicalize_filename(
                GLib.build_filenamev([GLib.path_get_dirname(path), specifier]), null));
        }
    }
    return seen;
}

function relative(path) {
    return path.startsWith(`${SRC}/`) ? path.slice(SRC.length + 1) : path;
}

print(`${'\x1b[1m'}The preferences' import graph${OFF} — src/prefs.js and everything it reaches`);
{
    const graph = graphFrom(GLib.build_filenamev([SRC, 'prefs.js']));

    // The graph itself, so that a module dropping out of it is visible: this
    // check is only worth anything while it is actually walking something.
    check('modules reached', graph.size > 1, true);

    for (const [path, specifiers] of graph) {
        const bad = specifiers.filter(s => FORBIDDEN.some(f => s.startsWith(f)));
        check(`${relative(path)} stays clear`, bad.join(', ') || 'yes', 'yes');
    }
}

print(`\n${'\x1b[1m'}Loading them${OFF} — outside the shell, as the preferences do`);
{
    // The two modules the preferences share with the shell. If either has
    // picked up an import it should not have, this is where it says so.
    const shared = ['lib/providers/registry.js', 'lib/settings.js'];
    const loaded = await Promise.all(shared.map(name =>
        import(`file://${GLib.build_filenamev([SRC, name])}`)
            .then(module => ({module}), e => ({error: e.message}))));

    for (const [i, name] of shared.entries())
        check(`${name} loads`, loaded[i].error ?? 'yes', 'yes');

    const registry = loaded[0].module;
    check('and the registry has providers in it', registry?.allProviders().length > 0, true);
}

print('');
if (failures) {
    print(`${RED}${failures} import check(s) failed.${OFF}`);
    throw new Error(`${failures} import check(s) failed`);
}
print(`${GREEN}All import checks passed.${OFF}`);
