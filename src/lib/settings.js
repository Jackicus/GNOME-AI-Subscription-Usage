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

// The extension's own schemas are not in the system directory, so the source
// has to be built against the extension's schemas/ -- with the default source
// as its parent, so a lookup still falls through to the system schemas.
function schemaSource(extensionDir) {
    return Gio.SettingsSchemaSource.new_from_directory(
        extensionDir.get_child('schemas').get_path(),
        Gio.SettingsSchemaSource.get_default(),
        false);
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
export function displayOptions(settings) {
    return {
        showInPanel: settings.get_boolean('show-in-panel'),
        showPerModel: settings.get_boolean('show-per-model'),
        showBreakdown: settings.get_boolean('show-breakdown'),
        showCredits: settings.get_boolean('show-credits'),
    };
}

// The switches worth showing for a provider: the ones its capabilities say it
// can honour. Keeping this beside the schema means the preferences never offer
// a switch that would do nothing.
export const PROVIDER_KEYS = [
    {key: 'show-in-panel', title: 'Can appear on the button',
        subtitle: 'With this off it is listed in the pop-up but never supplies the figure in the top bar.',
        capability: null},
    {key: 'show-per-model', title: 'List per-model limits', subtitle: null, capability: 'perModel'},
    {key: 'show-breakdown', title: 'Show where the usage went', subtitle: null, capability: 'breakdown'},
    {key: 'show-credits', title: 'Show paid-for extra usage', subtitle: null, capability: 'credits'},
];

export function keysFor(provider) {
    return PROVIDER_KEYS.filter(k => !k.capability || provider.capabilities?.[k.capability]);
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

