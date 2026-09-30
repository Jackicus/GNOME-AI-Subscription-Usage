// One place that decides whether the extension talks to the journal, so the
// development entry point can turn it up without every module knowing.

let verbose = false;

export function setVerbose(on) {
    verbose = !!on;
}

export function debug(message) {
    if (verbose)
        console.log(`[AI Usage] ${message}`);
}

export function warn(message) {
    console.warn(`[AI Usage] ${message}`);
}

export function error(message, e) {
    if (e)
        console.error(`[AI Usage] ${message}:`, e);
    else
        console.error(`[AI Usage] ${message}`);
}
