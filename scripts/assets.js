// Checks that every icon this extension ships can actually be loaded as one,
// and that every icon a provider asks for is a stock one GNOME ships.
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

print(`\n${'\x1b[1m'}Providers${OFF} — each asks for a stock Adwaita symbolic`);
{
    // The company's own marks may not ship (README, Credits and trademarks), so a
    // provider names an icon from Adwaita, which every GNOME has. A typo there is
    // silent: the button shows the gauge, as under a theme that lacks the icon.
    const themes = GLib.get_system_data_dirs().map(dir =>
        GLib.build_filenamev([dir, 'icons', 'Adwaita', 'symbolic']));

    function inAdwaita(name) {
        for (const theme of themes) {
            if (!GLib.file_test(theme, GLib.FileTest.IS_DIR))
                continue;
            const contexts = Gio.File.new_for_path(theme).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = contexts.next_file(null))) {
                const path = GLib.build_filenamev([theme, info.get_name(), `${name}.svg`]);
                if (GLib.file_test(path, GLib.FileTest.EXISTS))
                    return loads(path);
            }
        }
        return 'not in Adwaita';
    }

    for (const provider of PROVIDERS)
        check(`${provider.id} asks for ${provider.icon}`, inAdwaita(provider.icon), 'yes');
    const names = PROVIDERS.map(provider => provider.icon);
    check('no two providers share an icon', new Set(names).size, names.length);
}

print('');
if (failures) {
    print(`${RED}${failures} asset check(s) failed.${OFF}`);
    throw new Error(`${failures} asset check(s) failed`);
}
print(`${GREEN}All asset checks passed.${OFF}`);
