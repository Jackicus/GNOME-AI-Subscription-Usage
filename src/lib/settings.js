// Imports only Gio and usage.js: prefs.js loads it.

import Gio from 'gi://Gio';

import {severityFor} from './usage.js';

const PROVIDER_SCHEMA = 'org.gnome.shell.extensions.ai-usage.provider';
const PROVIDER_PATH = '/org/gnome/shell/extensions/ai-usage/providers';

// A system-wide install has no schemas/ of its own; its schemas are in the default source.
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

// The preferences offer only the switches a provider's capabilities can honour.
const PROVIDER_KEYS = [
    {key: 'show-per-model', title: 'List per-model limits', capability: 'perModel'},
    {key: 'show-breakdown', title: 'Show where the usage went', capability: 'breakdown'},
    {key: 'show-credits', title: 'Show paid-for extra usage', capability: 'credits'},
];

export function keysFor(provider) {
    return PROVIDER_KEYS.filter(k => provider.capabilities[k.capability]);
}

// The display switches and thresholds, as a view that leaves the Reading whole,
// so turning a switch back on needs no new request.
export function applyOptions(reading, options, thresholds) {
    const graded = row => ({...row, severity: severityFor(row.percent, thresholds, row.severity)});

    const view = Object.assign(Object.create(Object.getPrototypeOf(reading)), reading);
    view.limits = reading.limits
        .filter(limit => options.showPerModel || !limit.scoped)
        .map(graded);
    view.breakdown = options.showBreakdown ? reading.breakdown : [];
    view.credits = options.showCredits && reading.credits ? graded(reading.credits) : null;
    return view;
}

