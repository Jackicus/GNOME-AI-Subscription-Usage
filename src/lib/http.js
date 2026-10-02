import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Under the shortest poll interval the schema allows (60 s).
const TIMEOUT_SECONDS = 20;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;   // the HTTP status, or 0 when the request never landed
    }
}

export class Http {
    constructor(userAgent) {
        this._userAgent = userAgent;
        // No session-wide user agent: Antigravity answers 403 unless it looks like agy.
        this._session = new Soup.Session({
            timeout: TIMEOUT_SECONDS,
            idle_timeout: TIMEOUT_SECONDS,
        });
    }

    // Rejects with an HttpError carrying the status (0 when nothing came back).
    getJson(url, headers = {}, cancellable = null) {
        return this._send('GET', url, headers, null, cancellable);
    }

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
