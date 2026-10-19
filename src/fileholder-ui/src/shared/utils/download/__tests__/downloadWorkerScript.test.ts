import { describe, it, expect } from 'vitest';
import workerSource from '../../../../../public/download-sw.js?raw';
import { DOWNLOAD_WORKER_SCOPE, saveViaServiceWorker } from '../serviceWorkerSaving';
import { attachmentDisposition } from '../contentDisposition';

/**
 * Runs the real public/download-sw.js against the real page side, so a change to either half of the protocol
 * that the other doesn't follow fails here rather than in a browser.
 */

const ORIGIN = 'https://fileholder.test';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const FIRST_LENGTH = 3;
const SECOND_LENGTH = 2;
const FIRST = Uint8Array.from({ length: FIRST_LENGTH }, (_, i) => i + 1);
const SECOND = Uint8Array.from({ length: SECOND_LENGTH }, (_, i) => FIRST_LENGTH + i + 1);
const FILE_NAME = 'zażółć raport.pdf';

type Listener = (event: unknown) => void;

interface FetchEventStub {
    readonly request: { readonly url: string };
    readonly respondWith: (response: Response | Promise<Response>) => void;
}

/** Loads the worker script with a stand-in `self` and returns the event listeners it registered. */
const loadWorkerScript = (): Readonly<Record<string, Listener>> => {
    const listeners: Record<string, Listener> = {};
    const self = {
        addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
        skipWaiting: () => undefined,
        clients: { claim: async () => undefined },
        registration: { scope: `${ORIGIN}${DOWNLOAD_WORKER_SCOPE}` },
        location: { origin: ORIGIN },
    };
    new Function('self', workerSource)(self);
    return listeners;
};

/** Sends a request through the worker's fetch listener, the way an iframe navigation would. */
const fetchThroughWorker = (listeners: Readonly<Record<string, Listener>>, path: string): Promise<Response> =>
    new Promise((resolve) => {
        const event: FetchEventStub = { request: { url: `${ORIGIN}${path}` }, respondWith: (response) => resolve(Promise.resolve(response)) };
        listeners.fetch(event);
    });

/** Stands in for the hidden iframe: opening the URL sends the request through the worker. */
const iframeThrough = (listeners: Readonly<Record<string, Listener>>) => {
    const urls: string[] = [];
    let markOpened: (response: Promise<Response>) => void = () => undefined;
    const opened = new Promise<Response>((resolve) => { markOpened = resolve; });
    const openUrl = (url: string): void => {
        urls.push(url);
        markOpened(fetchThroughWorker(listeners, url));
    };
    return { opened, openUrl, urls };
};

const asServiceWorker = (listeners: Readonly<Record<string, Listener>>): ServiceWorker => ({
    postMessage: (data: unknown, transfer?: Transferable[]) => listeners.message({ data, ports: transfer ?? [] }),
}) as unknown as ServiceWorker;

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
        },
    });

describe('download-sw.js with the page side', () => {
    it('serves the page\'s stream as an attachment download, byte for byte', async () => {
        const listeners = loadWorkerScript();
        const { opened, openUrl } = iframeThrough(listeners);

        const saving = saveViaServiceWorker(streamOf(FIRST, SECOND), { fileName: FILE_NAME }, { getWorker: async () => asServiceWorker(listeners), openUrl });
        const served = await opened;
        const body = new Uint8Array(await served.arrayBuffer());

        expect(await saving).toBe('saved');
        expect(served.status).toBe(HTTP_OK);
        expect(served.headers.get('Content-Disposition')).toBe(attachmentDisposition(FILE_NAME));
        expect(served.headers.get('Content-Type')).toBe('application/octet-stream');
        expect(served.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(Array.from(body)).toEqual([...FIRST, ...SECOND]);
    });

    it('fails the download when the page\'s stream fails, so no partial file looks complete', async () => {
        const listeners = loadWorkerScript();
        const { opened, openUrl } = iframeThrough(listeners);
        const failing = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(FIRST);
                controller.error(new Error('Decryption failed at chunk 1'));
            },
        });

        const saving = saveViaServiceWorker(failing, { fileName: FILE_NAME }, { getWorker: async () => asServiceWorker(listeners), openUrl });
        const served = await opened;

        await Promise.all([
            expect(served.arrayBuffer()).rejects.toThrow('Decryption failed at chunk 1'),
            expect(saving).rejects.toThrow('Decryption failed at chunk 1'),
        ]);
    });

    it('answers each registered download once, and nothing it never registered', async () => {
        const listeners = loadWorkerScript();
        const { opened, openUrl, urls } = iframeThrough(listeners);

        const saving = saveViaServiceWorker(streamOf(FIRST), { fileName: FILE_NAME }, { getWorker: async () => asServiceWorker(listeners), openUrl });
        await (await opened).arrayBuffer();
        await saving;

        expect((await fetchThroughWorker(listeners, urls[0])).status).toBe(HTTP_NOT_FOUND);
        expect((await fetchThroughWorker(listeners, `${DOWNLOAD_WORKER_SCOPE}${crypto.randomUUID()}`)).status).toBe(HTTP_NOT_FOUND);
    });

    it('ignores a registration whose header value would carry a line break', () => {
        const listeners = loadWorkerScript();
        const channel = new MessageChannel();
        const replies: unknown[] = [];
        channel.port1.addEventListener('message', (event) => replies.push(event.data));
        channel.port1.start();

        listeners.message({ data: { type: 'register-download', id: crypto.randomUUID(), disposition: 'attachment\r\nX-Evil: 1' }, ports: [channel.port2] });

        return new Promise<void>((resolve) => setTimeout(() => {
            expect(replies).toEqual([]);
            resolve();
        }));
    });
});
