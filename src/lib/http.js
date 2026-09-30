// One libsoup session for the whole extension, and a GET that returns parsed
// JSON. Deliberately small: the only thing the extension ever does over the
// network is read its own account's figures.
//
// The wrapper is hand-rolled rather than Gio._promisify'd because promisifying
// works by patching the Soup prototype, which is shared with the rest of the
// shell and with every other extension in the process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Long enough to ride out a slow network, short enough that a poll cannot
// overlap the next one at the shortest interval the schema allows (60s).
const TIMEOUT_SECONDS = 20;

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;   // the HTTP status, or 0 when the request never landed
    }
}

export class Http {
    constructor(userAgent) {
        this._userAgent = userAgent;
        // The session carries no user agent of its own: at least one provider
        // is refused (403) unless the request looks like the tool whose login
        // it is, so the header is per-request and a provider can set its own.
        this._session = new Soup.Session({
            timeout: TIMEOUT_SECONDS,
            idle_timeout: TIMEOUT_SECONDS,
        });
    }

    // Resolves to the parsed body. Rejects with an HttpError carrying the status,
    // so a caller can tell "your login is stale" (401) from "the service is
    // having a bad day" (5xx) -- they read very differently to a user.
    getJson(url, headers = {}, cancellable = null) {
        return this._send('GET', url, headers, null, cancellable);
    }

    // Some providers answer usage questions over POST with a JSON body. It is
    // still a read: nothing here ever sends a request that changes anything.
    postJson(url, headers = {}, body = {}, cancellable = null) {
        return this._send('POST', url, headers, JSON.stringify(body), cancellable);
    }

    _send(method, url, headers, body, cancellable) {
        const message = Soup.Message.new(method, url);
        if (!message)
            return Promise.reject(new HttpError(0, `Not a usable URL: ${url}`));

        const requestHeaders = message.get_request_headers();
        for (const [name, value] of Object.entries(headers))
            requestHeaders.append(name, value);
        if (!headers['User-Agent'] && this._userAgent)
            requestHeaders.append('User-Agent', this._userAgent);

        if (body !== null) {
            message.set_request_body_from_bytes(
                'application/json', new GLib.Bytes(new TextEncoder().encode(body)));
        }

        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                    let bytes;
                    try {
                        bytes = session.send_and_read_finish(result);
                    } catch (e) {
                        // A cancelled poll is the extension being disabled or a
                        // newer poll taking over; it is not a fault to report.
                        if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            reject(e);
                        else
                            reject(new HttpError(0, e.message));
                        return;
                    }

                    const status = message.get_status();
                    if (status !== Soup.Status.OK) {
                        reject(new HttpError(status, `HTTP ${status} ${message.get_reason_phrase() ?? ''}`.trim()));
                        return;
                    }

                    const data = bytes?.get_data();
                    if (!data?.length) {
                        reject(new HttpError(status, 'The response was empty.'));
                        return;
                    }

                    try {
                        resolve(JSON.parse(new TextDecoder().decode(data)));
                    } catch (e) {
                        reject(new HttpError(status, `The response was not JSON: ${e.message}`));
                    }
                });
        });
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
