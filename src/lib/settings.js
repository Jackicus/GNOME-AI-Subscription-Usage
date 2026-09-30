// Per-provider settings.
//
// They live in a relocatable schema instantiated once per provider id, at
// /org/gnome/shell/extensions/ai-usage/providers/<id>/, so adding a provider
// needs no schema change at all.
//
// This module imports nothing but Gio on purpose: prefs.js runs in its own
// process, without the shell's imports, and has to be able to load it.

import Gio from 'gi://Gio';

const PROVIDER_SCHEMA = 'org.gnome.shell.extensions.ai-usage.provider';
const PROVIDER_PATH = '/org/gnome/shell/extensions/ai-usage/providers';

// The two ways the top bar can be arranged, as the `panel-mode` key spells
// them. Only `combined` has a single figure for the providers to compete for,
// which is the one thing that changes what the switches below mean.
export const PanelMode = {
    PER_PROVIDER: 'per-provider',
    COMBINED: 'combined',
};

// The extension's own schemas are not in the system directory, so the source is
// built against the extension's schemas/ -- with the default source as its
// parent, so a lookup still falls through to the system schemas.
//
// The missing-directory case is the shell's own: a user extension has a
// schemas/ subfolder, and one installed system-wide in the same prefix as the
// shell has its schemas in the default source instead. Without this, that
// second kind of install throws here rather than working.
function schemaSource(extensionDir) {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const schemaDir = extensionDir.get_child('schemas');
    if (!schemaDir.query_exists(null))
        return defaultSource;

    return Gio.SettingsSchemaSource.new_from_directory(
        schemaDir.get_path(), defaultSource, false);
}

export function providerSettings(extensionDir, providerId) {
    const schema = schemaSource(extensionDir).lookup(PROVIDER_SCHEMA, true);
    if (!schema)
        throw new Error(`Missing schema ${PROVIDER_SCHEMA}; run 'make reload' to recompile it.`);

    return new Gio.Settings({
        settings_schema: schema,
        path: `${PROVIDER_PATH}/${providerId}/`,
    });
}

// What the pop-up should leave out for this provider, gathered once so that
// neither the renderer nor the provider modules read settings themselves.
//
// The panel mode is taken here rather than further in because it decides what
// one of the switches means: with a button per provider there is no single
// figure to be kept off, so `show-in-panel` has nothing to say and is ignored.
// Reading it anyway would let a stale switch silently remove a whole button.
export function displayOptions(settings, mode = PanelMode.PER_PROVIDER) {
    return {
        showInPanel: mode === PanelMode.COMBINED
            ? settings.get_boolean('show-in-panel')
            : true,
        showPerModel: settings.get_boolean('show-per-model'),
        showBreakdown: settings.get_boolean('show-breakdown'),
        showCredits: settings.get_boolean('show-credits'),
    };
}

// The switches worth showing for a provider: the ones its capabilities say it
// can honour. Keeping this beside the schema means the preferences never offer
// a switch that would do nothing.
export const PROVIDER_KEYS = [
    {key: 'show-in-panel', title: 'Can appear on the shared button',
        subtitle: 'Only when the top bar is set to a single button for every provider: with this off it is '
            + 'listed in that pop-up but never supplies the figure beside the icon.',
        capability: null, mode: PanelMode.COMBINED},
    {key: 'show-per-model', title: 'List per-model limits', subtitle: null, capability: 'perModel'},
    {key: 'show-breakdown', title: 'Show where the usage went', subtitle: null, capability: 'breakdown'},
    {key: 'show-credits', title: 'Show paid-for extra usage', subtitle: null, capability: 'credits'},
];

export function keysFor(provider) {
    return PROVIDER_KEYS.filter(k => !k.capability || provider.capabilities?.[k.capability]);
}

// A key that only means something in one panel mode is still shown in the
// other -- hiding rows as a setting changes makes the window jump -- but it is
// insensitive there, which says plainly that it is not doing anything.
export function keyAppliesTo(key, mode) {
    return !key.mode || key.mode === mode;
}

// The display switches, applied in one place so that neither the provider
// modules nor the renderer read settings themselves.
//
// This returns a *view* -- a shallow copy sharing the prototype, so the getters
// still work -- and never touches the Reading it was given. Filtering in place
// would throw the hidden rows away, and turning a switch back on would then
// show nothing until the next poll happened to come round.
export function applyOptions(reading, options) {
    if (!options)
        return reading;

    const view = Object.assign(Object.create(Object.getPrototypeOf(reading)), reading);
    view.panelEligible = options.showInPanel;
    view.limits = options.showPerModel
        ? reading.limits
        : reading.limits.filter(limit => !limit.scoped);
    view.breakdown = options.showBreakdown ? reading.breakdown : [];
    view.credits = options.showCredits ? reading.credits : null;
    return view;
}

