// The development entry point, installed by `make link` in place of
// src/extension.js, which imports lib/ once as an install should. Nothing here
// ships.
//
// GJS caches ES modules by URL for the life of the process, so re-importing
// lib/ after an edit would hand back the old code. Every enable() therefore
// stages lib/ into a directory named after a checksum of its contents and
// imports from there: a fresh directory per *edit* (the stamp changes) reloads
// without a shell restart, while an unlock re-enables into the same stage and
// the same module graph, since session-modes defaults to ['user'] and the shell
// disables at lock. (A query string on the entry module alone is not enough --
// its static imports of sibling modules resolve without it.) Second-granularity
// mtimes alone would collide with `make reload` run twice inside the same
// second, which is why size and the mtime's usec are in the stamp too.
//
// The walk is recursive because lib/ has providers/ under it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ATTRS = 'standard::name,standard::type,standard::size,time::modified,time::modified-usec';

export default class AiUsageExtension extends Extension {
    async enable() {
        // disable() can arrive while the import is still pending, and would
        // find no app to take down; the one built afterwards would then never
        // be taken down at all.
        const enabling = {};
        this._enabling = enabling;
        try {
            const runDir = this._stageLib();
            const module = await import(`file://${runDir}/app.js`);
            const log = await import(`file://${runDir}/log.js`);
            if (this._enabling !== enabling)
                return;
            log.setVerbose(true);
            this._app = new module.AiUsageApp(this);
            this._app.enable();
            console.log(`[AI Usage] Enabled from ${runDir}`);
        } catch (e) {
            console.error('[AI Usage] Failed to load lib/app.js:', e);
        }
    }

    disable() {
        this._enabling = null;
        if (this._app) {
            try {
                this._app.disable();
            } catch (e) {
                console.error('[AI Usage] Error during disable:', e);
            }
            this._app = null;
        }
        // The stage this session used is kept on purpose (the next enable's
        // sweep removes it if it is now stale); only a live app is taken down.
    }

    _stageLib() {
        const base = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'ai-usage']);

        const files = [];
        this._walk(this.dir.get_child('lib'), '', files);
        files.sort((a, b) => a.path.localeCompare(b.path));

        const stamp = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, files.map(f => f.stamp).join('\n'), -1).slice(0, 16);

        const runDir = GLib.build_filenamev([base, `lib-${stamp}`]);
        if (!Gio.File.new_for_path(runDir).query_exists(null)) {
            for (const file of files) {
                const target = Gio.File.new_for_path(GLib.build_filenamev([runDir, file.path]));
                GLib.mkdir_with_parents(target.get_parent().get_path(), 0o700);
                file.source.copy(target, Gio.FileCopyFlags.OVERWRITE, null, null);
            }
        }
        // GJS caches modules by URL for the process's life, so a stage that
        // already exists (an unlock re-enabling into the same content) is served
        // from that cache with no copy needed.

        this._sweepStages(base, stamp);
        return runDir;
    }

    _walk(dir, prefix, out) {
        const it = dir.enumerate_children(ATTRS, Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = it.next_file(null))) {
            const name = info.get_name();
            const path = prefix ? `${prefix}/${name}` : name;
            const child = dir.get_child(name);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                this._walk(child, path, out);
            } else if (name.endsWith('.js')) {
                const mtime = info.get_modification_date_time();
                out.push({
                    path,
                    source: child,
                    stamp: `${path}:${info.get_size()}:${mtime.to_unix()}:${mtime.get_microsecond()}`,
                });
            }
        }
        it.close(null);
    }

    // Removes every stage but the one just built or reused -- leftovers from a
    // shell that exited without disable(), or from the edit before this one.
    _sweepStages(base, stamp) {
        const baseFile = Gio.File.new_for_path(base);
        if (!baseFile.query_exists(null))
            return;
        const it = baseFile.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = it.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY && info.get_name() !== `lib-${stamp}`)
                this._removeTree(baseFile.get_child(info.get_name()));
        }
        it.close(null);
    }

    _removeTree(file) {
        if (!file.query_exists(null))
            return;
        try {
            const it = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = it.next_file(null))) {
                const child = file.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    this._removeTree(child);
                else
                    child.delete(null);
            }
            it.close(null);
            file.delete(null);
        } catch (e) {
            console.warn(`[AI Usage] Could not clean ${file.get_path()}: ${e.message}`);
        }
    }
}
