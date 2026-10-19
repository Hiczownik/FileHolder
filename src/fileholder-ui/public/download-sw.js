/*
 * Streams decrypted downloads to disk. The page decrypts a file a chunk at a time; this worker turns those
 * chunks into an ordinary download response, so the browser writes them straight to disk instead of the page
 * having to hold the whole file in memory first.
 *
 * Protocol (one MessageChannel per download, see serviceWorkerSaving.ts):
 *   page -> worker  { type: 'register-download', id, disposition }  with the channel's port
 *   worker -> page  { type: 'registered' }
 *   page navigates a hidden iframe to <scope><id>; this worker answers it
 *   worker -> page  { type: 'started' }                 the browser has the response; no turning back
 *   worker -> page  { type: 'pull' }                    the browser wants the next chunk
 *   page -> worker  { type: 'chunk', bytes } | { type: 'done' } | { type: 'error', message }
 *   worker -> page  { type: 'cancel' }                  the user cancelled the download
 *
 * Registered with scope /__download/, so it never sees any other request of the app.
 */
'use strict';

// A registration nobody opens within this time is dropped.
const REGISTRATION_TTL_MS = 60 * 1000;
// If the page stops answering (closed tab, crash), fail the download instead of leaving it hanging forever.
const PULL_TIMEOUT_MS = 2 * 60 * 1000;
// Download ids are UUIDs from crypto.randomUUID().
const DOWNLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pending = new Map();

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') {
        return;
    }

    // { type: 'keepalive' } needs no handling: receiving a message is what keeps this worker running.
    if (data.type !== 'register-download') {
        return;
    }

    const port = event.ports[0];
    const validDisposition = typeof data.disposition === 'string' && !/[\r\n]/.test(data.disposition);
    if (!port || typeof data.id !== 'string' || !DOWNLOAD_ID.test(data.id) || !validDisposition) {
        return;
    }

    const now = Date.now();
    pending.forEach((entry, id) => {
        if (now - entry.registeredAt > REGISTRATION_TTL_MS) {
            entry.port.close();
            pending.delete(id);
        }
    });

    pending.set(data.id, { port, disposition: data.disposition, registeredAt: now });
    port.postMessage({ type: 'registered' });
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const scopePath = new URL(self.registration.scope).pathname;
    if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) {
        return;
    }

    // Each registration answers exactly one request.
    const id = url.pathname.slice(scopePath.length);
    const entry = pending.get(id);
    pending.delete(id);

    if (!entry || Date.now() - entry.registeredAt > REGISTRATION_TTL_MS) {
        event.respondWith(new Response('This download has expired. Start it again from the download page.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }));
        return;
    }

    entry.port.postMessage({ type: 'started' });
    event.respondWith(new Response(createBodyStream(entry.port), {
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': entry.disposition,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        },
    }));
});

function createBodyStream(port) {
    let answer = null;
    port.onmessage = (event) => {
        const respond = answer;
        answer = null;
        if (respond) {
            respond(event.data);
        }
    };

    return new ReadableStream({
        pull(controller) {
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    answer = null;
                    controller.error(new Error('The download page stopped responding.'));
                    port.close();
                    resolve();
                }, PULL_TIMEOUT_MS);

                answer = (message) => {
                    clearTimeout(timeout);
                    // Checked by tag, not instanceof: a buffer that crossed a realm boundary isn't an instance
                    // of this realm's ArrayBuffer.
                    const isBuffer = Object.prototype.toString.call(message && message.bytes) === '[object ArrayBuffer]';
                    if (message && message.type === 'chunk' && isBuffer) {
                        controller.enqueue(new Uint8Array(message.bytes));
                    } else if (message && message.type === 'done') {
                        controller.close();
                        port.close();
                    } else {
                        // Fails the download, so the browser never keeps a partial file as if it were complete.
                        controller.error(new Error((message && message.message) || 'The download failed.'));
                        port.close();
                    }
                    resolve();
                };

                port.postMessage({ type: 'pull' });
            });
        },
        cancel() {
            port.postMessage({ type: 'cancel' });
            port.close();
        },
    }, { highWaterMark: 1 });
}
