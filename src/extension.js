// The shipped entry point. It imports lib/app.js once, as an install should;
// scripts/dev-extension.js replaces this file in a development install so that
// edits reload without restarting the shell.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AiUsageApp} from './lib/app.js';

export default class AiUsageExtension extends Extension {
    enable() {
        this._app = new AiUsageApp(this);
        this._app.enable();
    }

    disable() {
        this._app?.disable();
        this._app = null;
    }
}
