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
export function displayOptions(settings) {
    return {
        showPerModel: settings.get_boolean('show-per-model'),
        showBreakdown: settings.get_boolean('show-breakdown'),
        showCredits: settings.get_boolean('show-credits'),
    };
}

// What a button itself is made of: whether it carries the icon, whether it
// carries the figure, and how big the icon is drawn. Gathered here for the same
// reason as displayOptions -- one place decides, and the renderer reads no
// settings at all.
//
// Both switches off is the one combination that must never reach the top bar.
// An actor with no icon and no figure is zero width: still there, still
// clickable in principle, and completely invisible -- which reads as the
// extension being broken rather than as anything anyone chose. So the icon
// comes back when the figure has been turned off as well, because the icon is
// what names the subscription the button belongs to. The preferences apply the
// same rule on the key the user did not touch, so what they see is the other
// switch coming back rather than this one quietly disagreeing with them.
export function buttonOptions(settings) {
    const showPercent = settings.get_boolean('show-percent');
    return {
        showIcon: settings.get_boolean('show-icon') || !showPercent,
        showPercent,
        iconSize: settings.get_int('icon-size'),
    };
}

// The switches worth showing for a provider: the ones its capabilities say it
// can honour. Keeping this beside the schema means the preferences never offer
// a switch that would do nothing.
export const PROVIDER_KEYS = [
    {key: 'show-per-model', title: 'List per-model limits', capability: 'perModel'},
    {key: 'show-breakdown', title: 'Show where the usage went', capability: 'breakdown'},
    {key: 'show-credits', title: 'Show paid-for extra usage', capability: 'credits'},
];

export function keysFor(provider) {
    return PROVIDER_KEYS.filter(k => provider.capabilities?.[k.capability]);
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
    view.limits = options.showPerModel
        ? reading.limits
        : reading.limits.filter(limit => !limit.scoped);
    view.breakdown = options.showBreakdown ? reading.breakdown : [];
    view.credits = options.showCredits ? reading.credits : null;
    return view;
}

