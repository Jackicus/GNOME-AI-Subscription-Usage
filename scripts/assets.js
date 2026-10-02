// Checks that every icon this extension ships can actually be loaded as one,
// and that every icon a provider asks for is there.
// `./scripts/dev.sh assets`, and `make check`.
//
// This exists because of a bug that survived from the first commit to the first
// screenshot. gdk-pixbuf identifies a file by sniffing its opening bytes, and
// every icon here led with a licence comment that pushed `<svg` past the window
// it looks at -- so not one of them was recognised as an image, the buttons all
// fell back to a gauge that could not load either, and the top bar showed a
// bare percentage with nothing beside it.
//
// Nothing caught it: the file is valid SVG, it renders in a browser, `make
// pack` ships it, and the only symptom is an icon that quietly is not there.
// Which is exactly the kind of thing a check is for.
//
// Nothing here ships.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {PROVIDERS} from '../src/lib/providers/registry.js';

const RED = '\x1b[1;31m';
const GREEN = '\x1b[1;32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const SRC = GLib.canonicalize_filename(GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'src']), null);
const ICONS = GLib.build_filenamev([SRC, 'icons']);

// The gauge every button falls back to. If this one is unloadable the fallback
// is no fallback at all, which is how the original bug managed to hide.
const FALLBACK = 'ai-usage-symbolic';

let failures = 0;

function check(what, got, want) {
    const ok = String(got) === String(want);
    if (!ok)
        failures++;
    const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    const detail = ok ? `${DIM}${got}${OFF}` : `${RED}got ${got}, wanted ${want}${OFF}`;
    print(`  ${mark} ${what.padEnd(42)} ${detail}`);
}

// At 16 pixels, which is the size a panel actually asks for.
function loads(path) {
    try {
        GdkPixbuf.Pixbuf.new_from_file_at_size(path, 16, 16);
        return 'yes';
    } catch (e) {
        return e.message.replace(/\s+/g, ' ').slice(0, 60);
    }
}

function iconNames() {
    const dir = Gio.File.new_for_path(ICONS);
    const names = [];
    const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null)))
        names.push(info.get_name());
    return names.filter(n => n.endsWith('.svg')).sort();
}

print(`${'\x1b[1m'}Icons${OFF} — every one that ships has to load as an image`);
{
    const names = iconNames();
    // A check that walks nothing passes trivially, so the walk is checked too.
    check('icons found', names.length > 0, true);

    for (const name of names)
        check(`${name} loads`, loads(GLib.build_filenamev([ICONS, name])), 'yes');

    check(`the fallback ${FALLBACK}.svg is there`,
        GLib.file_test(GLib.build_filenamev([ICONS, `${FALLBACK}.svg`]), GLib.FileTest.EXISTS), true);
}

print(`\n${'\x1b[1m'}Providers${OFF} — an icon asked for is an icon that exists`);
{
    // A typo in a provider's `icon` is silent: the button falls back to the
    // gauge and looks like a provider that simply has no icon of its own.
    for (const provider of PROVIDERS) {
        if (provider.icon === undefined) {
            check(`${provider.id} declares no icon`, 'falls back', 'falls back');
            continue;
        }
        const name = String(provider.icon).replace(/\.svg$/, '');
        const path = GLib.build_filenamev([ICONS, `${name}.svg`]);
        check(`${provider.id} asks for ${name}.svg`,
            GLib.file_test(path, GLib.FileTest.EXISTS) ? loads(path) : 'no such file', 'yes');
    }
}

print('');
if (failures) {
    print(`${RED}${failures} asset check(s) failed.${OFF}`);
    throw new Error(`${failures} asset check(s) failed`);
}
print(`${GREEN}All asset checks passed.${OFF}`);
